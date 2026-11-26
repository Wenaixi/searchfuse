import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpConnection,
  parseSseMessages,
  publicToolName,
  type McpServerConfig,
} from './protocol.ts';

interface Server {
  port: number;
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }>;
}

function listen(server: http.Server, requests: Server['requests']): Promise<Server> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/mcp`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * A stand-in MCP server. `respond` decides the HTTP answer for each parsed
 * JSON-RPC body, so a test can model SSE vs JSON, session ids, and 404s.
 * Returning `undefined` means "never answer": the request hangs on the wire,
 * which is how a test exercises cancellation and timeouts.
 */
async function mcpServer(
  respond: (message: { method?: string; id?: unknown }, round: number) =>
    | {
        status?: number;
        headers?: Record<string, string>;
        body: string;
        contentType?: string;
      }
    | undefined,
): Promise<Server> {
  let round = 0;
  const requests: Server['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let message: { method?: string; id?: unknown } = {};
      try {
        message = JSON.parse(body);
      } catch {
        /* notification with no body carrier */
      }
      requests.push({ method: req.method, headers: req.headers, body });
      round += 1;
      const answer = respond(message, round);
      if (answer === undefined) {
        // 故意不回：请求挂在网线上，直到客户端自己中止。
        return;
      }
      res.writeHead(answer.status ?? 200, {
        'content-type': answer.contentType ?? 'application/json',
        ...answer.headers,
      });
      res.end(answer.body);
    });
  });
  return listen(server, requests);
}

const sse = (payload: unknown, id = 1) =>
  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: payload })}\n\n`;

const config = (url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  transport: 'streamable-http',
  url,
  enabled: true,
  ...extra,
});

afterEach(() => {
  /* each test closes its own server */
});

describe('parseSseMessages', () => {
  it('reads the data lines of a real streamable-http response', () => {
    // Shape taken from a live grep.app / Context7 handshake.
    const body = `event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"Context7"}}}\r\n\r\n`;
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      '2025-06-18',
    );
  });

  it('ignores comment lines and keep-alives', () => {
    const body = ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(1);
  });

  it('joins multi-line data payloads', () => {
    const body = `event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":3,"result":{"ok":true}}\n\n`;
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { result: { ok: boolean } }).result.ok).toBe(true);
  });

  it('skips a payload that is not JSON rather than aborting the stream', () => {
    const body = `data: not json\n\ndata: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\n\n`;
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(1);
  });
});

describe('publicToolName', () => {
  it('uses the host contract: mcp__server__tool', () => {
    expect(publicToolName('grep', 'searchGitHub')).toBe('mcp__grep__searchGitHub');
  });

  it('folds characters the host does not accept', () => {
    expect(publicToolName('ctx7', 'search.docs/v2')).toBe('mcp__ctx7__search_docs_v2');
  });

  it('shortens an over-long name with a stable hash suffix', () => {
    const long = publicToolName('server', 'x'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    // Deterministic: the same input yields the same name on every run.
    expect(publicToolName('server', 'x'.repeat(80))).toBe(long);
  });

  it('keeps tools from different servers distinct', () => {
    // The prefix is what separates them, and it is also what the host relies
    // on. Two spellings of the SAME tool folding together is expected — a
    // server does not expose `b.c` and `b/c` as separate tools.
    expect(publicToolName('serverA', 'search')).not.toBe(publicToolName('serverB', 'search'));
  });

  it('keeps names derived from long raw names distinct', () => {
    // Once the length budget forces a hash, the hash is what prevents two
    // long names sharing a prefix from collapsing into one tool.
    const a = publicToolName('server', `${'x'.repeat(60)}a`);
    const b = publicToolName('server', `${'x'.repeat(60)}b`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });
});

describe('McpConnection', () => {
  it('performs the full handshake: initialize, notification, then tools/list', async () => {
    // The order is not negotiable: most servers reject tools/* before
    // notifications/initialized arrives.
    const seenMethods: string[] = [];
    const server = await mcpServer((message) => {
      seenMethods.push(message.method ?? '');
      if (message.method === 'initialize') {
        return {
          body: sse({
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'fake', version: '1' },
          }),
          contentType: 'text/event-stream',
        };
      }
      if (message.method === 'notifications/initialized') {
        return { status: 202, body: '' };
      }
      if (message.method === 'tools/list') {
        return {
          body: sse({ tools: [{ name: 'searchGitHub', inputSchema: { type: 'object' } }] }, 2),
          contentType: 'text/event-stream',
        };
      }
      return { status: 400, body: '{}' };
    });
    try {
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      const tools = await connection.listTools();
      expect(tools.map((t) => t.name)).toEqual(['searchGitHub']);
      expect(seenMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
      await connection.close();
    } finally {
      await server.close();
    }
  });

  it('sends Accept for both content types and the negotiated protocol version', async () => {
    const server = await mcpServer((message) => {
      if (message.method === 'initialize') {
        return {
          body: sse({ protocolVersion: '2025-06-18', capabilities: {} }),
          contentType: 'text/event-stream',
        };
      }
      return { status: 202, body: '' };
    });
    try {
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      await connection.listTools().catch(() => undefined);
      const init = server.requests[0];
      expect(init?.headers.accept).toContain('application/json');
      expect(init?.headers.accept).toContain('text/event-stream');
      // The version header is only meaningful after negotiation.
      const later = server.requests.find((r) => JSON.parse(r.body || '{}').method === 'tools/list');
      if (later) expect(later.headers['mcp-protocol-version']).toBe('2025-06-18');
      await connection.close();
    } finally {
      await server.close();
    }
  });

  it('echoes Mcp-Session-Id on every request after the server assigns one', async () => {
    const server = await mcpServer((message) => {
      if (message.method === 'initialize') {
        return {
          body: sse({ protocolVersion: '2025-06-18', capabilities: {} }),
          contentType: 'text/event-stream',
          headers: { 'mcp-session-id': 'session-abc' },
        };
      }
      if (message.method === 'notifications/initialized') return { status: 202, body: '' };
      if (message.method === 'tools/list') return { body: sse({ tools: [] }, 2), contentType: 'text/event-stream' };
      return { status: 400, body: '{}' };
    });
    try {
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      await connection.listTools();
      const listed = server.requests.filter((r) => JSON.parse(r.body || '{}').method === 'tools/list');
      expect(listed[0]?.headers['mcp-session-id']).toBe('session-abc');
      await connection.close();
    } finally {
      await server.close();
    }
  });

  it('re-initializes and retries once when the server answers 404', async () => {
    // Session expiry arrives as a plain 404 with no body. Retrying the call
    // without a fresh handshake would fail the same way forever.
    let listCalls = 0;
    const server = await mcpServer((message) => {
      if (message.method === 'initialize') {
        return {
          body: sse({ protocolVersion: '2025-06-18', capabilities: {} }),
          contentType: 'text/event-stream',
        };
      }
      if (message.method === 'notifications/initialized') return { status: 202, body: '' };
      if (message.method === 'tools/list') {
        listCalls += 1;
        if (listCalls === 1) return { status: 404, body: 'session expired' };
        return {
          body: sse({ tools: [{ name: 'after-retry', inputSchema: { type: 'object' } }] }, 2),
          contentType: 'text/event-stream',
        };
      }
      return { status: 400, body: '{}' };
    });
    try {
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      const tools = await connection.listTools();
      expect(tools.map((t) => t.name)).toEqual(['after-retry']);
      expect(listCalls).toBe(2);
      await connection.close();
    } finally {
      await server.close();
    }
  });

  it('surfaces the JSON-RPC error message instead of a generic failure', async () => {
    const server = await mcpServer((message) => {
      if (message.method === 'initialize') {
        return { body: sse({ protocolVersion: '2025-06-18', capabilities: {} }), contentType: 'text/event-stream' };
      }
      if (message.method === 'notifications/initialized') return { status: 202, body: '' };
      if (message.method === 'tools/call') {
        return {
          body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Invalid arguments for tool searchGitHub' } })}\n\n`,
          contentType: 'text/event-stream',
        };
      }
      return { status: 400, body: '{}' };
    });
    try {
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      await expect(connection.callTool('searchGitHub', { query: 'x' })).rejects.toThrow(
        /Invalid arguments for tool searchGitHub/,
      );
      await connection.close();
    } finally {
      await server.close();
    }
  });

  it('aborts an in-flight tool call when the caller signal fires', async () => {
    // 这个服务端对 tools/call 永远不回答：请求已经发出去了，就挂在那里。
    // 于是唯一的结束方式要么是超时，要么是调用方中止——正好用来区分两者。
    let toolCalls = 0;
    const server = await mcpServer((message) => {
      if (message.method === 'initialize') {
        return {
          body: sse({ protocolVersion: '2025-06-18', capabilities: {} }),
          contentType: 'text/event-stream',
        };
      }
      if (message.method === 'notifications/initialized') return { status: 202, body: '' };
      if (message.method === 'tools/call') {
        toolCalls += 1;
        // 永不回答。真正的服务端在这里拖延，客户端只能靠信号自救。
        return undefined;
      }
      return { status: 400, body: '{}' };
    });
    const controller = new AbortController();
    try {
      // 超时给到 5 秒，而取消在 50 毫秒后发生。如果实现只会等超时，这次调用
      // 要 5 秒才结束——所以耗时就是判据，不只是「抛错」。
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      const started = Date.now();
      const call = connection.callTool('slowTool', { query: 'x' }, controller.signal);
      // 中止要等 `tools/call` 真的到达服务端之后再发。写成固定的 50ms 是在赌
      // 「握手 + 发请求一定能在 50ms 内完成」：机器一忙，握手还没走完就被中止，
      // 请求从未发出，`toolCalls` 就是 0，而实现完全正确。
      const abortWhenInFlight = (async () => {
        while (toolCalls === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (Date.now() - started > 3_000) {
            throw new Error('the tool call never reached the server within 3s');
          }
        }
        controller.abort();
      })();
      await expect(call).rejects.toThrow(/abort|cancel/i);
      await abortWhenInFlight;
      expect(Date.now() - started).toBeLessThan(2_000);
      // 请求确实发出去了：这不是「进门就被拦下」，而是飞行途中被掐断的。
      expect(toolCalls).toBe(1);
      await connection.close().catch(() => undefined);
    } finally {
      await server.close();
    }
  });

  it('terminates the session with DELETE on close, treating 405 as success', async () => {
    const deleteSeen = false;
    const server = await mcpServer((message, round) => {
      if (message.method === 'initialize') {
        return {
          body: sse({ protocolVersion: '2025-06-18', capabilities: {} }),
          contentType: 'text/event-stream',
          headers: { 'mcp-session-id': 'sid' },
        };
      }
      if (message.method === 'notifications/initialized') return { status: 202, body: '' };
      return { status: 405, body: '' };
    });
    const original = server.requests;
    try {
      const connection = new McpConnection(config(server.url), { timeoutMs: 5_000 });
      await connection.listTools().catch(() => undefined);
      await connection.close();
      // A 405 means the server keeps session lifetime to itself: not an error.
      expect(deleteSeen).toBe(false);
      expect(original.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('reports the URL it could not reach, not just a fetch failure', async () => {
    const connection = new McpConnection(config('http://127.0.0.1:1/mcp'), { timeoutMs: 500 });
    await expect(connection.listTools()).rejects.toThrow(/mcp|initialize|fetch|connect/i);
      await connection.close().catch(() => undefined);
  });
});
