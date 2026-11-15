import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeStackexchangeSearch, stackexchangeProvider } from './stackexchange.ts';

function stubFetch(payload: unknown, status = 200) {
  const seen: Array<{ url: string }> = [];
  vi.stubGlobal('fetch', (url: string) => {
    seen.push({ url });
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status, headers: { 'content-type': 'application/json' },
    }));
  });
  return seen;
}

const request = (over: Record<string, unknown> = {}) => ({
  mode: 'search' as const, query: 'rust borrow checker', timeoutMs: 5000, settings: {}, ...over,
}) as never;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('stackexchange provider shape', () => {
  it('needs no key', () => {
    expect(stackexchangeProvider.isAvailable({}, {}, 'search')).toBe(true);
    expect(stackexchangeProvider.roles).toEqual(['search']);
  });
});

describe('stackexchange search', () => {
  it('queries the 2.3 API with relevance sort and a page size', async () => {
    const seen = stubFetch({ items: [] });
    await executeStackexchangeSearch(request());
    expect(seen[0]?.url).toContain('api.stackexchange.com/2.3/search/advanced');
    expect(seen[0]?.url).toContain('q=rust');
    expect(seen[0]?.url).toContain('site=stackoverflow');
    expect(seen[0]?.url).toMatch(/pagesize=\d+/);
  });

  it('maps answers into items with score and answered state as evidence', async () => {
    stubFetch({ items: [
      { title: 'Why does the borrow checker reject this?', link: 'https://stackoverflow.com/q/1',
        score: 128, is_answered: true, answer_count: 4, creation_date: 1709251200 },
      { title: 'Unanswered question', link: 'https://stackoverflow.com/q/2', score: 3, is_answered: false, answer_count: 0 },
    ]});
    const out = (await executeStackexchangeSearch(request())).result as {
      items: Array<Record<string, unknown>>; summary: string;
    };
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ title: 'Why does the borrow checker reject this?', url: 'https://stackoverflow.com/q/1', source: 'stackoverflow.com' });
    expect(String(out.items[0]?.snippet)).toMatch(/128/);
    expect(String(out.items[0]?.snippet)).toMatch(/answered/);
    expect(out.items[0]?.published_at).toMatch(/2024-/);
    expect(out.summary).toMatch(/2/);
  });

  it('decodes HTML entities the API returns in titles', async () => {
    stubFetch({ items: [{ title: 'How to use &lt;div&gt; &amp; CSS', link: 'https://stackoverflow.com/q/3', score: 1, is_answered: true }] });
    const out = (await executeStackexchangeSearch(request())).result as { items: Array<{ title: string }> };
    expect(out.items[0]?.title).toBe('How to use <div> & CSS');
  });

  it('reports an API error_message instead of an empty result', async () => {
    stubFetch({ error_message: 'throttled' }, 200);
    await expect(executeStackexchangeSearch(request())).rejects.toThrow(/throttled/);
  });

  it('reports empty results as uncertainty', async () => {
    stubFetch({ items: [] });
    const out = (await executeStackexchangeSearch(request())).result as { items: unknown[]; uncertainty: string[] };
    expect(out.items).toEqual([]);
    expect(out.uncertainty.join()).toMatch(/No results/);
  });

  it('refuses page fetch', async () => {
    await expect(executeStackexchangeSearch(request({ mode: 'fetch' }))).rejects.toThrow(/does not support page fetch/);
  });

  it('requires a query', async () => {
    await expect(executeStackexchangeSearch(request({ query: undefined }))).rejects.toThrow(/query/);
  });

  it('caps results', async () => {
    stubFetch({ items: Array.from({ length: 30 }, (_, i) => ({ title: `Q${i}`, link: `https://stackoverflow.com/q/${i}`, score: 30 - i, is_answered: true })) });
    const out = (await executeStackexchangeSearch(request({ maxResults: 5 }))).result as { items: unknown[] };
    expect(out.items).toHaveLength(5);
  });
});
