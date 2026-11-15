// 手写的 MCP 客户端，只实现 Streamable HTTP 传输。
//
// 范围刻意收窄：只做工具，不做 stdio、不做 OAuth、不做 resources 与 prompts、
// 不做流续传。这正是 `mcp.grep.app` 与 `mcp.context7.com` 需要的，而两者
// 都允许匿名访问。
//
// 这个客户端做了、而一个朴素 POST 会漏掉的协议工作：
//
// - `initialize` 必须是第一个请求，之后必须先发 `notifications/initialized`
//   才能调任何 `tools/*`。多数服务端会拒绝顺序不对的调用。
// - 响应可能是 `application/json`，也可能是 SSE 流；两种都正常，两种都得能读。
// - 服务端可能会分配 `Mcp-Session-Id`，之后每个请求都必须回显它。它过期时
//   服务端返回无 body 的 404，唯一的补救是重新握手。
// - 协商完成后必须发送 `MCP-Protocol-Version`。
import { createHash } from 'node:crypto';

export interface McpServerConfig {
  transport: 'streamable-http';
  url: string;
  enabled?: boolean;
  /** 附加的请求头，例如 Context7 的 API 密钥。 */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const HANDSHAKE_PROTOCOL_VERSION = DEFAULT_PROTOCOL_VERSION;

/** 宿主自己的工具名契约，这里等价复制，好让同一个名字在两边含义一致。 */
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isServerNameValid(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name);
}

/**
 * `mcp__<server>__<tool>`, folded to the character set the host accepts and
 * shortened with a stable hash when it would exceed the name budget.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  // 折叠字符并不是触发哈希的原因：一个不得不折叠但长度仍够的名字完全可读。
  // 只有超长才会强制成带哈希后缀的缩短形式，而哈希正是用来让两个折叠后
  // 前缀相同的工具保持区分的东西。
  if (normalized.length <= MAX_PUBLIC_NAME_LENGTH) {
    return normalized;
  }
  const hash = createHash('sha256')
    .update(`${serverName}\0${rawName}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Read the JSON-RPC messages out of an SSE body.
 *
 * Comment lines (`:`) are keep-alives, blank lines separate events, and a
 * `data:` payload may be split across several lines. Anything that does not
 * parse as JSON is skipped rather than fatal: a server is allowed to emit
 * event types this client does not model, and one stray frame must not lose
 * the real answer behind it.
 */
export function parseSseMessages(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (dataLines.length === 0) {
      continue;
    }
    try {
      messages.push(JSON.parse(dataLines.join('\n')) as JsonRpcMessage);
    } catch {
      // 这个客户端读不懂的一帧，不是调用方能够处理的那种错误。
    }
  }
  return messages;
}

export class McpProtocolError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
  }
}

/**
 * One server connection.
 *
 * Not shared between runs: an MCP server may be stateless, and holding a
 * socket open buys nothing for a search engine that already fans out
 * concurrent requests.
 */
export class McpConnection {
  private sessionId: string | undefined;
  private protocolVersion = HANDSHAKE_PROTOCOL_VERSION;
  private initialized = false;
  private readonly config: McpServerConfig;
  private readonly timeoutMs: number;

  constructor(config: McpServerConfig, options: { timeoutMs?: number } = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 30_000;
  }

  get serverUrl(): string {
    return this.config.url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.config.headers,
      ...extra,
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }
    if (this.initialized) {
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    return headers;
  }

  /**
   * One JSON-RPC request. Returns the matching response message.
   *
   * A 404 is the protocol's way of saying the session is gone, so it triggers
   * one fresh handshake and one retry. Nothing else is retried: a 401 or a
   * malformed answer means the server rejected the call, and repeating it
   * would just fail again.
   */
  private async request(
    body: Record<string, unknown>,
    id: number,
    allowReconnect = true,
  ): Promise<JsonRpcMessage> {
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 202) {
      return {};
    }
    if (response.status === 404 && allowReconnect) {
      // 会话可能已经过期。重来一次；第二次再 404 就是真的了。
      this.sessionId = undefined;
      this.initialized = false;
      await this.handshake();
      if (Object.hasOwn(body, 'id')) {
        return this.request(body, id, false);
      }
      return {};
    }

    const text = await response.text();
    if (!response.ok) {
      throw new McpProtocolError(
        `MCP server ${this.config.url} answered ${response.status}.${text ? ` ${text.slice(0, 300)}` : ''}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const messages = contentType.includes('event-stream')
      ? parseSseMessages(text)
      : (() => {
          try {
            return [JSON.parse(text) as JsonRpcMessage];
          } catch {
            return [];
          }
        })();

    const matched = messages.find((message) => message.id === id) ?? messages.at(-1);
    if (matched?.error !== undefined) {
      throw new McpProtocolError(
        matched.error.message ?? 'MCP server returned an error with no message',
        matched.error.code,
      );
    }
    return matched ?? {};
  }

  private async notify(method: string): Promise<void> {
    await fetch(this.config.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** initialize, then notifications/initialized. Idempotent within a run. */
  async handshake(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const initId = 1;
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.config.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'modsearch', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // 会话 id 藏在这个响应的响应头里，要在解析 body 之前就取出来。
    const assigned = response.headers.get('mcp-session-id');
    if (assigned) {
      this.sessionId = assigned;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new McpProtocolError(
        `MCP server ${this.config.url} refused initialize with ${response.status}.${text ? ` ${text.slice(0, 300)}` : ''}`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('event-stream') && text !== '') {
      try {
        const parsed = JSON.parse(text) as JsonRpcMessage;
        const version = (parsed.result as { protocolVersion?: string } | undefined)
          ?.protocolVersion;
        if (typeof version === 'string' && version !== '') {
          this.protocolVersion = version;
        }
      } catch {
        /* the notification below is what the server actually needs */
      }
    }

    this.initialized = true;
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolSpec[]> {
    await this.handshake();
    const collected: McpToolSpec[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: cursor === undefined ? {} : { cursor },
        },
        2,
      );
      const result = response.result as
        | { tools?: McpToolSpec[]; nextCursor?: string }
        | undefined;
      for (const tool of result?.tools ?? []) {
        collected.push(tool);
      }
      cursor = result?.nextCursor;
      if (cursor === undefined || cursor === '') {
        break;
      }
    }
    return collected;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.handshake();
    const response = await this.request(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      3,
    );
    return response.result;
  }

  /** Explicit teardown. A 405 means the server keeps sessions to itself. */
  async close(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      await fetch(this.config.url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.sessionId, ...this.config.headers },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // 连接本来就要被丢弃了；一次失败的告别不是用户能看见的问题。
    }
    this.sessionId = undefined;
    this.initialized = false;
  }
}
