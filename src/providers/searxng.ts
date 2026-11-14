// SearXNG (https://docs.searxng.org/dev/search_api.html). In-process search
// engine, search only, in the same shape as the other keyless API engines.
//
// No default host: a public instance almost always answers 403 because
// `format: json` is off in its settings.yml, so guessing a host would turn a
// configuration omission into a run-time failure. `baseURL` is therefore
// required, and isAvailable reports false without it.
//
// One instance already fans out to dozens of upstream engines internally, so
// this provider contributes one ranked list like any other. Weight is not
// raised to reflect that: RRF fusion measures agreement between independent
// sources, and inflating a single source's vote would distort it.
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import { resolveEndpoint } from './endpoint.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export async function executeSearxngSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The searxng engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const startedAt = Date.now();
  const base = resolveEndpoint(options.settings.baseURL, '', '/search');
  const url = new URL(base);
  url.searchParams.set('q', options.query);
  url.searchParams.set('format', 'json');
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  const { response, text } = await requestText(
    'searxng',
    url.toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [options.settings.baseURL],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    const detail = redactSecrets(text.trim(), [options.settings.baseURL]);
    // 403 on a healthy instance is the format gate far more often than it is
    // an access problem, so the message names the setting that fixes it.
    if (response.status === 403) {
      throw new Error(
        `searxng refused the request (403). A public instance usually has format=json disabled; enable it with "search: formats: [html, json]" in that instance's settings.yml, or point engines.searxng.baseURL at your own instance.${detail ? ` (${detail})` : ''}`,
      );
    }
    throw new Error(
      `searxng returned ${response.status}.${detail ? ` ${detail}` : ''}`,
    );
  }

  let data: SearxngResponse;
  try {
    data = JSON.parse(text) as SearxngResponse;
  } catch {
    // An HTML page here means the instance ignored format=json and served the
    // web UI, which is the same misconfiguration 403 reports outright.
    throw new Error(
      'searxng answered with something that is not JSON. The instance is probably serving HTML because format=json is not enabled in its settings.yml.',
    );
  }

  const items = (data.results ?? [])
    .filter((r): r is SearxngResult & { url: string } => typeof r.url === 'string' && r.url !== '')
    .slice(0, maxResults)
    .map((r) => {
      const item: {
        title: string;
        url: string;
        snippet: string;
        source: string | undefined;
        published_at?: string;
      } = {
        title: r.title ?? '',
        url: r.url,
        snippet: r.content ?? '',
        source: safeHostname(r.url),
      };
      if (r.publishedDate) {
        item.published_at = r.publishedDate;
      }
      return item;
    });

  const summary =
    items.length > 0
      ? `SearXNG returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'SearXNG aggregates its configured upstream engines and returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
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

export const searxngProvider: SearchEngine = {
  name: 'searxng',
  roles: ['search'],
  requirement:
    'a SearXNG baseURL whose settings.yml enables format: json (public instances usually leave it off and answer 403)',
  // No sensible default host exists, so an unconfigured entry must not claim
  // availability: a chain runner would otherwise be parked and fail at call
  // time with a configuration problem dressed up as a run-time one.
  isAvailable: (settings) => typeof settings.baseURL === 'string' && settings.baseURL.trim() !== '',
  execute: executeSearxngSearch,
};
