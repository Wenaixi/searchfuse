import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiKeyFailure } from '../util/apiKeys.ts';
import { resolveEngine } from './index.ts';
import { executeAnySearch } from './anysearch.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mock the global fetch with a JSON response, capturing the request. */
function mockFetch(
  body: unknown,
  init: { status?: number; text?: string } = {},
  perCall?: Array<{ status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let callIndex = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, requestInit: RequestInit) => {
      calls.push({ url, init: requestInit });
      const reply = perCall?.[callIndex] ?? { status: init.status ?? 200, body };
      callIndex += 1;
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        statusText: reply.status === 200 ? 'OK' : 'Error',
        text: async () => (reply.status === 200 ? JSON.stringify(reply.body) : init.text ?? JSON.stringify(reply.body)),
      } as unknown as Response;
    }),
  );
  return calls;
}

function search(settings: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return executeAnySearch({
    mode: 'search',
    query: 'node 24 lts',
    timeoutMs: 1000,
    settings,
    ...extra,
  });
}

interface SearchOutcome {
  summary: string;
  items: unknown[];
  uncertainty: string[];
  warnings: string[];
}

/** 把引擎输出的 unknown result 收窄成测试能读的形状。 */
function outOf(outcome: Awaited<ReturnType<typeof search>>): SearchOutcome {
  return outcome.result as unknown as SearchOutcome;
}

/** 与查询共享标题词汇的结果，用来通过相关性过滤。 */
function relevantResults(): { code: number; data: { results: { url: string; title: string; snippet: string }[] } } {
  return {
    code: 0,
    data: {
      results: [
        { url: 'https://nodejs.org/24', title: 'Node.js 24 LTS', snippet: 'Node 24 is the latest LTS release' },
        { url: 'https://nodejs.org/download', title: 'Node.js Downloads', snippet: 'Download Node 24' },
        { url: 'https://example.com/node', title: 'Node 24 Guide', snippet: 'Guide to Node 24' },
      ],
    },
  };
}

describe('anysearch provider', () => {
  it('is a search engine that needs no setup', () => {
    const engine = resolveEngine('anysearch');
    expect(engine.name).toBe('anysearch');
    expect(engine.roles).toEqual(['search']);
    expect(engine.isAvailable({}, {}, 'search')).toBe(true);
    expect(engine.execute).toBeTypeOf('function');
  });

  it('rejects fetch mode', async () => {
    await expect(
      executeAnySearch({
        mode: 'fetch',
        url: 'https://example.com',
        timeoutMs: 1000,
        settings: {},
      }),
    ).rejects.toThrow(/does not support page fetch/);
  });

  it('calls the search endpoint with no auth header when no key is set', async () => {
    const calls = mockFetch(relevantResults());
    await search({}, { maxResults: 5 });
    expect(calls[0].url).toBe('https://api.anysearch.com/v1/search');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      query: 'node 24 lts',
      max_results: 5,
    });
  });

  it('sends the API key as a bearer token when one is set', async () => {
    const calls = mockFetch(relevantResults());
    await search({ apiKey: 'k123' }, { maxResults: 5 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k123');
  });

  it('falls back to the anonymous tier and notes it when a key is rejected', async () => {
    const ok = { code: 0, data: { results: [{ url: 'https://nodejs.org/24', title: 'Node.js 24 LTS', snippet: 'Node 24 release' }] } };
    const calls = mockFetch(ok, { status: 401 }, [
      { status: 401, body: {} },
      { status: 200, body: ok },
    ]);
    const out = await search({ apiKey: 'bad-key' });
    // 第一次带 key 被拒，第二次匿名成功。
    expect(calls.length).toBe(2);
    expect((calls[1].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(outOf(out).warnings.join(' ')).toContain('used the anonymous tier');
  });

  it('does not fall back when a keyless request is rejected', async () => {
    const calls = mockFetch({}, { status: 401 });
    await expect(search({})).rejects.toThrow(/anysearch returned 401/);
    expect(calls.length).toBe(1);
  });

  it('reports a 429 on the anonymous pool as a user-actionable message', async () => {
    mockFetch({}, { status: 429 });
    await expect(search({})).rejects.toThrow(
      /anonymous pool is rate-limited.*config set anysearch\.apiKey/,
    );
  });

  it('classifies 402 as a quota failure for cooldown', async () => {
    mockFetch({}, { status: 402 });
    await expect(search({ apiKey: 'k' })).rejects.toMatchObject({
      name: 'ApiKeyFailureError',
    });
    await expect(search({ apiKey: 'k' })).rejects.toThrow(/out of credits/);
  });

  it('classifies 403 with a key as an API key failure', async () => {
    // 带 key 时 401/403 表示 key 无效。参考实现把它归类为 ApiKeyFailureError，
    // cooldown 层据此跳过下一次撞墙而不是反复重试。注意：带 key 时 403 会
    // 触发降级匿名重试，所以这里断言第二次（匿名）请求收到 403 时的行为。
    const calls = mockFetch({}, { status: 403 }, [
      { status: 403, body: {} },
      { status: 403, body: {} },
    ]);
    const err = await search({ apiKey: 'bad' }).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(isApiKeyFailure(err)).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('maps results to items with a source hostname', async () => {
    mockFetch(relevantResults());
    const out = await search({});
    const items = outOf(out).items as Array<{ url: string; title: string; snippet: string; source: string }>;
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({
      url: 'https://nodejs.org/24',
      title: 'Node.js 24 LTS',
      source: 'nodejs.org',
    });
    expect(outOf(out).summary).toContain('3');
  });

  it('drops a batch that shares no vocabulary with the query', async () => {
    // 结果全是无关英文单词，与 'node 24 lts' 无共享词汇 → 整批判空。
    mockFetch({
      code: 0,
      data: {
        results: [
          { url: 'https://a.example/1', title: 'Quantum Zephyr', snippet: 'Unrelated content about quarks' },
          { url: 'https://a.example/2', title: 'Kaleidoscope', snippet: 'Nothing to do here' },
          { url: 'https://a.example/3', title: 'Mountain Dew', snippet: 'Soda reviews' },
        ],
      },
    });
    const out = await search({});
    expect(outOf(out).items).toEqual([]);
    expect(outOf(out).uncertainty.join(' ')).toContain('no relation to the query');
  });

  it('redacts secrets from error messages', async () => {
    mockFetch({ message: 'invalid secret abc123' }, { status: 500, text: 'gateway says secret abc123 bad' });
    const err = await search({ apiKey: 'abc123' }).catch((e: Error) => e) as Error;
    expect(err.message).not.toContain('abc123');
  });
});