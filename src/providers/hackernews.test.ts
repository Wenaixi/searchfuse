import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeHackernewsSearch, hackernewsProvider } from './hackernews.ts';

function stubFetch(payload: unknown, status = 200) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
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

const request = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'search' as const,
    query: 'rust async',
    timeoutMs: 5_000,
    settings: {},
    ...over,
  }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hackernews provider shape', () => {
  it('needs no key and is always available', () => {
    expect(hackernewsProvider.isAvailable({}, {}, 'search')).toBe(true);
    expect(hackernewsProvider.roles).toEqual(['search']);
  });

  it('names the source it queries', () => {
    expect(hackernewsProvider.requirement).toMatch(/nothing|no key|keyless/i);
  });
});

describe('hackernews search', () => {
  it('queries the Algolia endpoint with the query and a page size', async () => {
    const seen = stubFetch({ hits: [] });
    await executeHackernewsSearch(request());
    expect(seen[0]?.url).toContain('hn.algolia.com/api/v1/search');
    expect(seen[0]?.url).toContain('query=rust');
    expect(seen[0]?.url).toMatch(/hitsPerPage=\d+/);
  });

  it('maps stories into the canonical item shape with points and comments as evidence', async () => {
    stubFetch({
      hits: [
        {
          objectID: '1',
          title: 'Async Rust in practice',
          url: 'https://blog.example/async',
          points: 342,
          num_comments: 128,
          created_at: '2024-03-01T10:00:00Z',
        },
        { objectID: '2', title: 'Show HN: a thing', url: '', points: 12, num_comments: 3 },
      ],
    });
    const out = (await executeHackernewsSearch(request())).result as {
      items: Array<Record<string, unknown>>;
      summary: string;
    };
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      title: 'Async Rust in practice',
      url: 'https://blog.example/async',
      source: 'blog.example',
      published_at: '2024-03-01',
    });
    expect(String(out.items[0]?.snippet)).toMatch(/342 points/);
    // A story posted without a URL links to its own discussion thread.
    expect(out.items[1]?.url).toBe('https://news.ycombinator.com/item?id=2');
    expect(out.summary).toMatch(/2 discussion result/);
  });

  it('reports an empty search as uncertainty rather than an empty answer', async () => {
    stubFetch({ hits: [] });
    const out = (await executeHackernewsSearch(request())).result as {
      items: unknown[];
      uncertainty: string[];
    };
    expect(out.items).toEqual([]);
    expect(out.uncertainty.join()).toMatch(/No results/);
  });

  it('carries a rate-limit status into the error rather than pretending success', async () => {
    stubFetch({}, 429);
    await expect(executeHackernewsSearch(request())).rejects.toThrow(/429/);
  });

  it('refuses page fetch, which this API cannot serve', async () => {
    await expect(executeHackernewsSearch(request({ mode: 'fetch' }))).rejects.toThrow(
      /does not support page fetch/,
    );
  });

  it('requires a query', async () => {
    await expect(executeHackernewsSearch(request({ query: undefined }))).rejects.toThrow(/query/);
  });

  it('caps results at the requested maximum', async () => {
    stubFetch({
      hits: Array.from({ length: 20 }, (_, i) => ({
        objectID: String(i),
        title: `S${i}`,
        url: `https://s${i}.example/x`,
        points: 100 - i,
        num_comments: 1,
      })),
    });
    const out = (await executeHackernewsSearch(request({ maxResults: 4 }))).result as {
      items: unknown[];
    };
    expect(out.items).toHaveLength(4);
  });
});
