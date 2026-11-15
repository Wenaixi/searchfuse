// Stack Overflow search through the StackExchange 2.3 API
// (https://api.stackexchange.com/docs). In-process search engine, search
// only, in the same shape as the other API engines.
//
// No key for modest volume: the API allows 300 requests a day per IP
// anonymously, which is far past what a search chain spends. Score and
// answered state are folded into the snippet because they are the only
// quality signal this source offers — an accepted answer and an unanswered
// question sit at the same rank otherwise.
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;
const STACKEXCHANGE_API = 'https://api.stackexchange.com/2.3/search/advanced';

interface StackexchangeQuestion {
  title?: string;
  link?: string;
  score?: number;
  is_answered?: boolean;
  answer_count?: number;
  creation_date?: number;
}

interface StackexchangeResponse {
  items?: StackexchangeQuestion[];
  error_message?: string;
}

/**
 * The API escapes entities in titles (`&lt;div&gt;` for `<div>`). Left
 * encoded, the model reads markup notation instead of the words the asker
 * used.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function executeStackexchangeSearch(
  options: EngineRequest,
): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error(
      'The stackexchange engine does not support page fetch (-u). It searches questions only.',
    );
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const startedAt = Date.now();
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const url = new URL(STACKEXCHANGE_API);
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('q', options.query);
  url.searchParams.set('site', 'stackoverflow');
  url.searchParams.set('pagesize', String(Math.min(maxResults, 30)));
  // An answer needs the question's body; the default filter omits fields
  // this mapping reads.
  url.searchParams.set('filter', 'default');

  const { response, text } = await requestText(
    'stackexchange',
    url.toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    throw new Error(
      `stackexchange returned ${response.status}.${text ? ` ${redactSecrets(text.trim(), []).slice(0, 200)}` : ''}`,
    );
  }

  const data = JSON.parse(text) as StackexchangeResponse;
  // The API reports throttling and bad parameters as a 200 with an
  // error_message, so an empty item list alone would read as "no results".
  if (typeof data.error_message === 'string' && data.error_message !== '') {
    throw new Error(`stackexchange: ${data.error_message}`);
  }

  const items = (data.items ?? [])
    .map((question) => {
      const title = decodeEntities(question.title ?? '');
      const link = question.link ?? '';
      if (title === '' || link === '') {
        return undefined;
      }
      const evidence: string[] = [];
      if (typeof question.score === 'number') {
        evidence.push(`score ${question.score}`);
      }
      evidence.push(question.is_answered === true ? 'answered' : 'unanswered');
      if (typeof question.answer_count === 'number' && question.answer_count > 0) {
        evidence.push(`${question.answer_count} answer(s)`);
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
        snippet: evidence.join(', '),
        source: safeHostname(link),
      };
      if (typeof question.creation_date === 'number') {
        item.published_at = new Date(question.creation_date * 1000).toISOString().slice(0, 10);
      }
      return item;
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, maxResults);

  const summary =
    items.length > 0
      ? `Stack Overflow returned ${items.length} question(s) for "${options.query}". Read items for the accepted answers.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'Stack Overflow answers what developers asked and accepted, not the authoritative documentation; check dates on older questions.',
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

export const stackexchangeProvider: SearchEngine = {
  name: 'stackexchange',
  roles: ['search'],
  requirement: 'nothing: the StackExchange 2.3 API answers modest volume with no key',
  isAvailable: () => true,
  execute: executeStackexchangeSearch,
};
