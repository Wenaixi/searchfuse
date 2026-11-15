import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeArxivSearch, arxivProvider } from './arxiv.ts';

const ATOM = (entries: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n${entries}\n</feed>`;

function stubFetch(body: string, status = 200) {
  const seen: Array<{ url: string }> = [];
  vi.stubGlobal('fetch', (url: string) => {
    seen.push({ url });
    return Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/atom+xml' } }),
    );
  });
  return seen;
}

const request = (over: Record<string, unknown> = {}) =>
  ({ mode: 'search' as const, query: 'gpt quantization', timeoutMs: 15000, settings: {}, ...over }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('arxiv provider shape', () => {
  it('needs no key', () => {
    expect(arxivProvider.isAvailable({}, {}, 'search')).toBe(true);
    expect(arxivProvider.roles).toEqual(['search']);
  });
});

describe('arxiv search', () => {
  it('queries the export API with the query and a max result count', async () => {
    const seen = stubFetch(ATOM(''));
    await executeArxivSearch(request());
    expect(seen[0]?.url).toContain('export.arxiv.org/api/query');
    expect(seen[0]?.url).toContain('search_query=all%3Agpt');
    expect(seen[0]?.url).toMatch(/max_results=\d+/);
  });

  it('parses Atom entries into items with authors as the snippet', async () => {
    stubFetch(
      ATOM(`
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Efficient Quantization for Large Language Models</title>
    <summary>We present a method for quantizing large language models.</summary>
    <published>2024-01-02T00:00:00Z</published>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <title>Another Paper</title>
    <summary>Second abstract.</summary>
    <published>2024-02-03T00:00:00Z</published>
    <author><name>Carol</name></author>
  </entry>`),
    );
    const out = (await executeArxivSearch(request())).result as {
      items: Array<Record<string, unknown>>;
      summary: string;
    };
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      title: 'Efficient Quantization for Large Language Models',
      url: 'http://arxiv.org/abs/2401.00001v1',
      source: 'arxiv.org',
      published_at: '2024-01-02',
    });
    expect(String(out.items[0]?.snippet)).toMatch(/Alice Smith/);
    expect(out.summary).toMatch(/2\b/);
  });

  it('keeps control characters and entities in titles readable', async () => {
    stubFetch(
      ATOM(`
  <entry>
    <id>http://arxiv.org/abs/1</id>
    <title>On the &lt;Special&gt; Case &amp; More</title>
    <summary>Abstract</summary>
    <author><name>A</name></author>
  </entry>`),
    );
    const out = (await executeArxivSearch(request())).result as { items: Array<{ title: string }> };
    expect(out.items[0]?.title).toBe('On the <Special> Case & More');
  });

  it('collapses the whitespace arXiv wraps titles and abstracts in', async () => {
    stubFetch(
      ATOM(`
  <entry>
    <id>http://arxiv.org/abs/1</id>
    <title>
      A Very
      Long   Title
    </title>
    <summary>
      An abstract
      split across lines.
    </summary>
    <author><name>A</name></author>
  </entry>`),
    );
    const out = (await executeArxivSearch(request())).result as {
      items: Array<{ title: string; snippet: string }>;
    };
    expect(out.items[0]?.title).toBe('A Very Long Title');
  });

  it('reports an HTTP error rather than an empty result', async () => {
    stubFetch('', 503);
    await expect(executeArxivSearch(request())).rejects.toThrow(/503/);
  });

  it('reports no entries as uncertainty', async () => {
    stubFetch(ATOM(''));
    const out = (await executeArxivSearch(request())).result as {
      items: unknown[];
      uncertainty: string[];
    };
    expect(out.items).toEqual([]);
    expect(out.uncertainty.join()).toMatch(/No results/);
  });

  it('refuses page fetch', async () => {
    await expect(executeArxivSearch(request({ mode: 'fetch' }))).rejects.toThrow(
      /does not support page fetch/,
    );
  });

  it('requires a query', async () => {
    await expect(executeArxivSearch(request({ query: undefined }))).rejects.toThrow(/query/);
  });
});
