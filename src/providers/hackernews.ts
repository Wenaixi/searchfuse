// Hacker News search through the Algolia index
// (https://hn.algolia.com/api). In-process search engine, search only, in
// the same shape as the other API engines.
//
// No key and no signup: Algolia serves this index publicly at 10,000
// requests an hour per IP. Points and comment counts are folded into the
// snippet because on this source they are the quality signal — a story with
// 300 points is a different thing from one with 3, and a bare title hides
// exactly that difference.
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;
const HACKERNEWS_API = 'https://hn.algolia.com/api/v1/search';

interface HackernewsHit {
  objectID?: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
}

interface HackernewsResponse {
  hits?: HackernewsHit[];
}

export async function executeHackernewsSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error(
      'The hackernews engine does not support page fetch (-u). It searches discussion threads only.',
    );
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const startedAt = Date.now();
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const url = new URL(HACKERNEWS_API);
  url.searchParams.set('query', options.query);
  url.searchParams.set('hitsPerPage', String(Math.min(maxResults, 50)));
  // Stories and comments both answer "what do people say about this"; the
  // wider tag set keeps a query from missing the discussion because it
  // happened in a comment thread rather than a submission.
  url.searchParams.set('tags', '(story,comment)');

  const { response, text } = await requestText(
    'hackernews',
    url.toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    throw new Error(`hackernews returned ${response.status}.${text ? ` ${redactSecrets(text.trim(), []).slice(0, 200)}` : ''}`);
  }

  const data = JSON.parse(text) as HackernewsResponse;
  const items = (data.hits ?? [])
    .map((hit) => {
      const title = hit.title ?? hit.story_title ?? '';
      const target = hit.url ?? hit.story_url ?? '';
      // A story submitted as a text post has no external URL; its discussion
      // thread is the page that holds the answer.
      const link =
        target !== ''
          ? target
          : hit.objectID
            ? `https://news.ycombinator.com/item?id=${hit.objectID}`
            : '';
      if (link === '' || title === '') {
        return undefined;
      }
      const evidence: string[] = [];
      if (typeof hit.points === 'number') {
        evidence.push(`${hit.points} points`);
      }
      if (typeof hit.num_comments === 'number') {
        evidence.push(`${hit.num_comments} comments`);
      }
      const item: {
        title: string;
        url: string;
        snippet: string;
        source: string | undefined;
        published_at?: string;
      } = {
        title,
        url: link,
        snippet:
          evidence.length > 0
            ? `${evidence.join(', ')} on Hacker News`
            : 'Discussion on Hacker News',
        source: safeHostname(link),
      };
      if (hit.created_at) {
        item.published_at = hit.created_at.slice(0, 10);
      }
      return item;
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, maxResults);

  const summary =
    items.length > 0
      ? `Hacker News returned ${items.length} discussion result(s) for "${options.query}". Read items for the threads and their links.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'Hacker News is a discussion index, not a web index: it answers what developers said about a topic, not the authoritative page on it.',
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

export const hackernewsProvider: SearchEngine = {
  name: 'hackernews',
  roles: ['search'],
  requirement: 'nothing: the Algolia-backed Hacker News index answers publicly with no key',
  // No key, no binary, no endpoint to configure: always available.
  isAvailable: () => true,
  execute: executeHackernewsSearch,
};
