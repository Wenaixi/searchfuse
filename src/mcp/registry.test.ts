import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { extractText, MCP_OUTPUT_SCHEMA, registerMcpServers } from './registry.ts';

function listen(server: http.Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const sse = (payload: unknown, id = 1) =>
  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: payload })}\n\n`;

/** A server that advertises `tools` and answers calls with their name. */
async function toolsServer(tools: Array<Record<string, unknown>>) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let message: { method?: string; id?: unknown; params?: { name?: string } } = {};
      try {
        message = JSON.parse(body);
      } catch {
        /* notification */
      }
      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } }));
        return;
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse({ tools }, 2));
        return;
      }
      if (message.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          sse(
            {
              content: [{ type: 'text', text: `called ${message.params?.name}` }],
            },
            3,
          ),
        );
        return;
      }
      res.writeHead(400);
      res.end();
    });
  });
  return listen(server);
}

interface FakeCtx {
  registered: Array<{ name: string; description: string; parameters: unknown; output: unknown }>;
  tools: { register: (definition: unknown) => unknown };
}

function fakeCtx(): FakeCtx {
  const registered: FakeCtx['registered'] = [];
  return {
    registered,
    tools: {
      register: (definition: unknown) => {
        registered.push(definition as FakeCtx['registered'][number]);
        return () => undefined;
      },
    },
  };
}

describe('extractText', () => {
  it('joins text blocks and drops the rest', () => {
    expect(
      extractText([
        { type: 'text', text: 'first' },
        { type: 'image', data: 'zzz' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\n\nsecond');
  });

  it('survives a malformed result', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText('plain')).toBe('plain');
    expect(extractText([{}])).toBe('');
  });
});

describe('MCP_OUTPUT_SCHEMA', () => {
  it('is the minimal shape the DSH tool runtime accepts', () => {
    // assertSupportedJsonSchema only allows a small subset; a raw MCP
    // content array is not among them, so the wrapper is what makes the tool
    // registrable at all.
    expect(MCP_OUTPUT_SCHEMA.type).toBe('object');
    expect(MCP_OUTPUT_SCHEMA.required).toEqual(['content']);
    expect(MCP_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('registerMcpServers', () => {
  it('registers one tool per advertised tool, named with the host contract', async () => {
    const ctx = fakeCtx();
    const server = await toolsServer([
      { name: 'searchGitHub', description: 'search code', inputSchema: { type: 'object' } },
    ]);
    try {
      const result = await registerMcpServers(ctx, {
        servers: { grep: { transport: 'streamable-http', url: server.url } },
      });
      expect(result.reports[0]?.connected).toBe(true);
      expect(result.reports[0]?.tools).toEqual(['mcp__grep__searchGitHub']);
      expect(ctx.registered).toHaveLength(1);
      expect(ctx.registered[0]?.name).toBe('mcp__grep__searchGitHub');
      await result.closeAll();
    } finally {
      await server.close();
    }
  });

  it('skips a disabled server entirely', async () => {
    const ctx = fakeCtx();
    const result = await registerMcpServers(ctx, {
      servers: { grep: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', enabled: false } },
    });
    expect(result.reports).toEqual([]);
    expect(ctx.registered).toEqual([]);
    await result.closeAll();
  });

  it('honours a per-server tool allow-list', async () => {
    const ctx = fakeCtx();
    const server = await toolsServer([
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: { type: 'object' } },
    ]);
    try {
      const result = await registerMcpServers(ctx, {
        servers: { srv: { transport: 'streamable-http', url: server.url } },
        allowTools: { srv: ['a'] },
      });
      expect(ctx.registered.map((r) => r.name)).toEqual(['mcp__srv__a']);
      await result.closeAll();
    } finally {
      await server.close();
    }
  });

  it('reports a dead server without failing the whole registration', async () => {
    // A missing convenience must not take down search, so a broken server is
    // a report line, not a thrown error.
    const ctx = fakeCtx();
    const result = await registerMcpServers(ctx, {
      servers: {
        dead: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', timeoutMs: 300 },
      },
    });
    expect(result.reports[0]?.connected).toBe(false);
    expect(result.reports[0]?.error).toBeTruthy();
    expect(ctx.registered).toEqual([]);
    await result.closeAll();
  });

  it('keeps one healthy server working when another is dead', async () => {
    const ctx = fakeCtx();
    const server = await toolsServer([{ name: 'ok', inputSchema: { type: 'object' } }]);
    try {
      const result = await registerMcpServers(ctx, {
        servers: {
          live: { transport: 'streamable-http', url: server.url },
          dead: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', timeoutMs: 300 },
        },
      });
      expect(result.reports.find((r) => r.serverKey === 'live')?.connected).toBe(true);
      expect(result.reports.find((r) => r.serverKey === 'dead')?.connected).toBe(false);
      expect(ctx.registered.map((r) => r.name)).toEqual(['mcp__live__ok']);
      await result.closeAll();
    } finally {
      await server.close();
    }
  });

  it('refuses a server key that cannot be part of a tool name', async () => {
    const ctx = fakeCtx();
    const result = await registerMcpServers(ctx, {
      servers: { 'my.server': { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } },
    });
    expect(result.reports[0]?.error).toMatch(/key/i);
    expect(ctx.registered).toEqual([]);
    await result.closeAll();
  });

  it('refuses a tool name the host already took', async () => {
    const ctx = fakeCtx();
    const server = await toolsServer([{ name: 'x', inputSchema: { type: 'object' } }]);
    try {
      const result = await registerMcpServers(ctx, {
        servers: { srv: { transport: 'streamable-http', url: server.url } },
        reservedNames: ['mcp__srv__x'],
      });
      expect(ctx.registered).toEqual([]);
      expect(result.reports[0]?.error).toMatch(/already taken/);
      await result.closeAll();
    } finally {
      await server.close();
    }
  });

  it('marks tools concurrency safe so they do not serialize behind search', async () => {
    const ctx = fakeCtx();
    const server = await toolsServer([{ name: 'q', inputSchema: { type: 'object' } }]);
    try {
      const result = await registerMcpServers(ctx, {
        servers: { srv: { transport: 'streamable-http', url: server.url } },
      });
      const def = ctx.registered[0] as unknown as {
        isConcurrencySafe?: () => boolean;
        timeoutMs?: number;
      };
      expect(def.isConcurrencySafe?.()).toBe(true);
      await result.closeAll();
    } finally {
      await server.close();
    }
  });
});
