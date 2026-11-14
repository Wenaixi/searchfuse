import { describe, expect, it } from 'vitest';
import { McpConnection, publicToolName } from './protocol.ts';

// Live checks against the two anonymous servers this client targets. They are
// opt-in (MODSEARCH_LIVE=1) so the default suite stays hermetic and offline:
// a test suite that always needs the network fails for reasons unrelated to
// the code under change.
const live = process.env.MODSEARCH_LIVE === '1' ? describe : describe.skip;

live('live MCP servers', () => {
  it('grep.app: lists searchGitHub and runs a real call anonymously', async () => {
    const conn = new McpConnection({ transport: 'streamable-http', url: 'https://mcp.grep.app' }, { timeoutMs: 40_000 });
    try {
      const tools = await conn.listTools();
      expect(tools.map((t) => t.name)).toContain('searchGitHub');
      const result = (await conn.callTool('searchGitHub', { query: 'useStreamableHTTP' })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeUndefined();
      const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
      expect(text).toMatch(/github|Repository/i);
    } finally {
      await conn.close();
    }
  });

  it('context7: works anonymously, with no API key at all', async () => {
    const conn = new McpConnection(
      { transport: 'streamable-http', url: 'https://mcp.context7.com/mcp' },
      { timeoutMs: 40_000 },
    );
    try {
      const tools = await conn.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('resolve-library-id');
      expect(names).toContain('query-docs');
      const result = (await conn.callTool('resolve-library-id', {
        query: 'react hooks',
        libraryName: 'react',
      })) as { content?: Array<{ type: string; text?: string }> };
      const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
      expect(text).toMatch(/react/i);
    } finally {
      await conn.close();
    }
  });

  it('uses the host tool-name contract for every tool it exposes', async () => {
    const conn = new McpConnection({ transport: 'streamable-http', url: 'https://mcp.grep.app' }, { timeoutMs: 40_000 });
    try {
      const tools = await conn.listTools();
      for (const tool of tools) {
        const name = publicToolName('grep', tool.name);
        expect(name.startsWith('mcp__grep__')).toBe(true);
        expect(name.length).toBeLessThanOrEqual(64);
      }
    } finally {
      await conn.close();
    }
  });
});
