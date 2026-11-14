// A hand-written MCP client for the Streamable HTTP transport.
//
// Scope is deliberately narrow: tools only, no stdio, no OAuth, no resources
// or prompts, no stream resumption. That is what `mcp.grep.app` and
// `mcp.context7.com` need, and both answer anonymously.
//
// The protocol work this client does that a naive POST would miss:
//
// - `initialize` must be the first request, and `notifications/initialized`
//   must follow it before any `tools/*` call. Most servers reject an
//   out-of-order call.
// - A response arrives as `application/json` OR as an SSE stream; both are
//   normal and both must be read.
// - A server may assign `Mcp-Session-Id`, which then has to be echoed on
//   every later request. If it expires the server answers 404 with no body,
//   and the only recovery is a fresh handshake.
// - `MCP-Protocol-Version` has to be sent after negotiation.
import { createHash } from 'node:crypto';

export interface McpServerConfig {
  transport: 'streamable-http';
  url: string;
  enabled?: boolean;
  /** Extra request headers, e.g. a Context7 API key. */
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

/** The host's own tool-name contract, mirrored so a name means the same thing. */
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
  // Folding characters is not what triggers the hash: a name that had to be
  // folded but still fits is perfectly readable. Only length forces a
  // shortened, hash-suffixed form, and the hash is what keeps two tools that
  // fold to the same prefix distinct.
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
      // A frame this client cannot read is not an error the caller can act on.
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
      // The session may have expired. Start over once; a second 404 is real.
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

    // The session id lives on this response's headers, before any body parse.
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
      // The connection is being abandoned anyway; a failed goodbye is not a
      // user-visible problem.
    }
    this.sessionId = undefined;
    this.initialized = false;
  }
}
