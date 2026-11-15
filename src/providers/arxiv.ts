// arXiv search through the export API
// (http://export.arxiv.org/api/query). In-process search engine, search
// only, in the same shape as the other API engines.
//
// No key. The service asks for roughly one request every three seconds and
// says so; a search chain spends far less than that, and the request timeout
// is what keeps a slow response from holding the run.
//
// The response is Atom XML. It is read with a narrow regular expression rather
// than an XML parser: the document is small and regular, four fields are
// wanted, and adding a parser dependency for that is not a trade worth making.
// The failure mode of this approach is a missing field, not a wrong one, and
// every field is validated below.
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;
const ARXIV_API = 'http://export.arxiv.org/api/query';

interface ArxivEntry {
  title: string;
  url: string;
  summary: string;
  authors: string[];
  published?: string;
}

/** Atom wraps its text; the API indents titles and abstracts across lines. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Pull the four fields out of each `<entry>` block. */
function parseEntries(body: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  // Non-greedy so adjacent entries do not swallow one another.
  for (const match of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1] ?? '';
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const id = block.match(/<id>([\s\S]*?)<\/id>/)?.[1];
    const summary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    const published = block.match(/<published>([\s\S]*?)<\/published>/)?.[1];
    const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map(
      (authorMatch) => collapse(decodeEntities(authorMatch[1] ?? '')),
    );
    if (title === undefined || id === undefined) {
      continue;
    }
    const entry: ArxivEntry = {
      title: collapse(decodeEntities(title)),
      url: collapse(id),
      summary: collapse(decodeEntities(summary ?? '')),
      authors,
    };
    if (published !== undefined) {
      entry.published = collapse(published).slice(0, 10);
    }
    if (entry.title === '' || entry.url === '') {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

export async function executeArxivSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error(
      'The arxiv engine does not support page fetch (-u). It searches preprints only.',
    );
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const startedAt = Date.now();
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const url = new URL(ARXIV_API);
  // `all:` searches every field; a bare term would be read as a field name.
  url.searchParams.set('search_query', `all:${options.query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(Math.min(maxResults, 50)));
  url.searchParams.set('sortBy', 'relevance');

  const { response, text } = await requestText(
    'arxiv',
    url.toString(),
    { method: 'GET', headers: { accept: 'application/atom+xml' } },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    throw new Error(
      `arxiv returned ${response.status}.${text ? ` ${redactSecrets(text.trim(), []).slice(0, 200)}` : ''}`,
    );
  }

  const items = parseEntries(text)
    .slice(0, maxResults)
    .map((entry) => {
      const item: {
        title: string;
        url: string;
        snippet: string;
        source: string | undefined;
        published_at?: string;
      } = {
        title: entry.title,
        url: entry.url,
        // Authors first: on a paper the byline is what tells the model whose
        // work it is reading.
        snippet:
          entry.authors.length > 0
            ? `${entry.authors.join(', ')}${entry.summary ? ` — ${entry.summary}` : ''}`
            : entry.summary,
        source: safeHostname(entry.url),
      };
      if (entry.published) {
        item.published_at = entry.published;
      }
      return item;
    });

  const summary =
    items.length > 0
      ? `arXiv returned ${items.length} preprint(s) for "${options.query}". Read items for authors and abstracts.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'arXiv holds preprints: they are not peer reviewed, and a newer version may contradict the abstract shown here.',
      ],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export const arxivProvider: SearchEngine = {
  name: 'arxiv',
  roles: ['search'],
  requirement: 'nothing: the export API answers with no key (about one request every three seconds)',
  isAvailable: () => true,
  execute: executeArxivSearch,
};
