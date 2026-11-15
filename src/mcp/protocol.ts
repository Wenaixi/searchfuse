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
 * `mcp__<server>__<tool>`，折叠到宿主接受的字符集，超长时用稳定的哈希缩短。
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
 * 从 SSE 响应体里读出 JSON-RPC 消息。
 *
 * 注释行（`:`）是保活，空行分隔事件，而 `data:` 载荷可能拆成好几行。
 * 解析不了 JSON 的内容直接跳过，而不是当作致命错误：服务端有权发出
 * 本客户端不认识的事件类型，一帧跑偏不能把后面真正的答案弄丢。
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
 * 一条服务端连接。
 *
 * 不在多次运行之间共享：MCP 服务端可能是无状态的，而对一个本就并发扇出
 * 请求的搜索引擎来说，占着一只 socket 不关也换不来任何好处。
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
   * 本次调用的取消信号：本次调用的超时，加上调用方传进来的那个。
   *
   * 两者用 AbortSignal.any 合并，谁先到都算取消。于是超时保护照旧，而用户
   * 中途点停止也能真的把在飞的请求掐断，而不是让它跑完再自己超时。
   */
  private signalFor(external: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return external === undefined ? timeout : AbortSignal.any([timeout, external]);
  }

  /**
   * 一次 JSON-RPC 请求。返回与之匹配的响应消息。
   *
   * 404 是协议表达「会话已没了」的方式，所以它会触发一次重新握手加一次重试。
   * 其他情况一律不重试：401 或格式不对的响应意味着服务端拒绝了这次调用，
   * 重复一遍只会再失败一次。
   */
  private async request(
    body: Record<string, unknown>,
    id: number,
    allowReconnect = true,
    external?: AbortSignal,
  ): Promise<JsonRpcMessage> {
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: this.signalFor(external),
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
        // 重试同样带上调用方的信号，否则取消能力在这一次重试里就断了。
        return this.request(body, id, false, external);
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

  /** 先 initialize，再 notifications/initialized。单次运行内幂等。 */
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
        /* 真正对服务端有用的是下面那条通知 */
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new McpProtocolError(`MCP call ${name} was cancelled before it started.`);
    }
    await this.handshake();
    const response = await this.request(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      3,
      true,
      signal,
    );
    return response.result;
  }

  /** 显式拆除。405 意味着服务端把会话留给自己管。 */
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
