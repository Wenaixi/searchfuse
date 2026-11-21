import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSearxngSearch, searxngProvider } from './searxng.ts';

function stubFetch(payload: unknown, status = 200) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return seen;
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: 'http://127.0.0.1:8888',
    ...overrides,
  } as never;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'search' as const,
    query: 'rust async',
    timeoutMs: 5_000,
    settings: settings(),
    ...overrides,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('searxng provider shape', () => {
  it('needs either a baseURL or an explicit opt-in to the bundled instance', () => {
    // 随包实例约 22 MiB 且首次启动要解压，所以它是显式开关，不是默认值：
    // 裸机器若默认启用，第一次搜索就会去拉一个原生产物。
    expect(searxngProvider.isAvailable(settings({ baseURL: undefined }), {}, 'search')).toBe(false);
    expect(searxngProvider.isAvailable(settings({ baseURL: '' }), {}, 'search')).toBe(false);
    expect(searxngProvider.isAvailable({} as never, {}, 'search')).toBe(false);
    // 用户托付的实例：旧语义，只要填了 URL 就可用。
    expect(searxngProvider.isAvailable(settings({ baseURL: 'http://searx.local' }), {}, 'search')).toBe(true);
    // 明确打开随包实例。
    expect(searxngProvider.isAvailable(settings({ embedded: true }), {}, 'search')).toBe(true);
  });

  it('serves search only, not page fetch', () => {
    expect(searxngProvider.roles).toEqual(['search']);
  });

  it('names the format=json setting in its requirement', () => {
    expect(searxngProvider.requirement).toMatch(/format=json|json/i);
  });
});

describe('searxng search', () => {
  it('calls the documented JSON endpoint with the query', async () => {
    const seen = stubFetch({
      results: [
        { title: 'A', url: 'https://a.example/x', content: 'snippet a' },
      ],
    });
    await executeSearxngSearch(request());
    expect(seen[0]?.url).toContain('http://127.0.0.1:8888/search');
    expect(seen[0]?.url).toContain('q=rust+async');
    expect(seen[0]?.url).toContain('format=json');
  });

  it('maps results into the canonical item shape', async () => {
    stubFetch({
      results: [
        { title: 'A', url: 'https://a.example/x', content: 'snippet a', publishedDate: '2024-01-01' },
        { title: 'B', url: 'https://b.example/y', content: '' },
        { title: 'NoURL', content: 'dropped' },
      ],
    });
    const out = (await executeSearxngSearch(request())).result as {
      items: Array<Record<string, unknown>>;
      summary: string;
      uncertainty: string[];
    };
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      title: 'A',
      url: 'https://a.example/x',
      snippet: 'snippet a',
      source: 'a.example',
      published_at: '2024-01-01',
    });
    expect(out.items[1]).toMatchObject({ title: 'B', snippet: '' });
    expect(out.items[1]?.published_at).toBeUndefined();
    expect(out.summary).toMatch(/2 ranked result/);
  });

  it('reports no results as uncertainty rather than an empty answer', async () => {
    stubFetch({ results: [] });
    const out = (await executeSearxngSearch(request())).result as {
      items: unknown[];
      uncertainty: string[];
    };
    expect(out.items).toEqual([]);
    expect(out.uncertainty.join()).toMatch(/No results/);
  });

  it('explains the 403 that a public instance returns when format=json is off', async () => {
    // The single most likely failure: a perfectly healthy public instance
    // answering 403 because its settings.yml never enabled JSON.
    stubFetch({}, 403);
    await expect(executeSearxngSearch(request())).rejects.toThrow(/format=json|settings\.yml/);
  });

  it('carries the HTTP status when the instance answers with an error', async () => {
    stubFetch({}, 500);
    await expect(executeSearxngSearch(request())).rejects.toThrow(/500/);
  });

  it('refuses page fetch, which SearXNG cannot do', async () => {
    await expect(executeSearxngSearch(request({ mode: 'fetch' }))).rejects.toThrow(
      /does not support page fetch/,
    );
  });

  it('requires a query in search mode', async () => {
    await expect(executeSearxngSearch(request({ query: undefined }))).rejects.toThrow(/query/);
  });

  it('honours maxResults as a result limit', async () => {
    stubFetch({
      results: Array.from({ length: 12 }, (_, i) => ({
        title: `R${i}`,
        url: `https://r${i}.example/x`,
        content: `s${i}`,
      })),
    });
    const out = (await executeSearxngSearch(request({ maxResults: 5 }))).result as {
      items: unknown[];
    };
    expect(out.items).toHaveLength(5);
  });
});
