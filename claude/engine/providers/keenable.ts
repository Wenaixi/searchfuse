// 形态与 exa.ts 相同。没有密钥时调用该端点的免密钥 `/public` 孪生接口，
// Keenable 对它按 IP 限制每小时 1,000 次请求，并且要求带上
// `X-Keenable-Title` 头，声明调用方应用名。有密钥则改走认证路径：
// 没有小时上限，每个组织每月 100,000 次免费请求。
// 返回结果是带摘要的排序页面，不含成文答案，所以摘要只是机械拼接。
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import { safeHostname } from '../util/host.ts';
import { redactSecrets } from '../util/redact.ts';
import { getEngineDeps } from '../deps.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import { resolveEndpoint } from './endpoint.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from '../types.ts';

const DEFAULT_MAX_RESULTS = 10;
/** Keenable 只接受 1-50 范围内的 max_results。 */
const MAX_RESULTS_CEILING = 50;
const KEENABLE_DEFAULT_BASE = 'https://api.keenable.ai';
/** 免密钥调用必填：Keenable 用它归属匿名流量。 */
const APP_TITLE = 'modsearch';

interface KeenableResult {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
  published_at?: string;
}

interface KeenableResponse {
  mode?: string;
  results?: KeenableResult[];
}

export async function executeKeenableSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The keenable engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0] ?? null;
  const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CEILING);
  const startedAt = Date.now();

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['x-keenable-title'] = APP_TITLE;
  }
  const { response, text } = await getEngineDeps().requestText(
    'keenable',
    resolveEndpoint(
      options.settings.baseURL,
      KEENABLE_DEFAULT_BASE,
      apiKey ? '/v1/search' : '/v1/search/public',
    ),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: options.query, max_results: maxResults }),
    },
    getEngineDeps().signalTimeout(options.timeoutMs),
    options.timeoutMs,
    [...apiKeySecrets, options.settings.baseURL],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    // 网关的错误响应体是外部文本；在它进入错误消息之前先做脱敏。
    const detail = redactSecrets(text.trim(), [...apiKeySecrets, options.settings.baseURL]);
    const message = `keenable returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`;
    if (response.status >= 500) {
      throw new Error(message);
    }
    if (!apiKey) {
      // 免密钥池由该 IP 上的所有人共用，所以这里的 429 与用户自己的配置无关。
      throw new Error(
        response.status === 429
          ? `keenable's keyless pool for this IP is used up for the hour (1,000 requests). Set a free key for your own quota: searchfuse config set keenable.apiKey <key> (100,000 requests/month, https://app.keenable.ai)`
          : message,
      );
    }
    // 402 表示月度配额度已耗尽：这属于让冷却层挂起一整天的配额类，而不是反复去撞。
    if (response.status === 402 || isQuotaFailureMessage(detail)) {
      throw new ApiKeyFailureError(
        `keenable is out of credits (HTTP ${response.status}).${detail ? ` ${detail}` : ''} Buy credits at https://app.keenable.ai/console, wait for the monthly reset, or search with another engine.`,
      );
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new ApiKeyFailureError(
        response.status === 429
          ? message
          : `keenable rejected the API key (${response.status}). Fix it: searchfuse config set keenable.apiKey <key>${detail ? ` (${detail})` : ''}`,
      );
    }
    throw new Error(message);
  }

  const data = JSON.parse(text) as KeenableResponse;

  const items = (data.results ?? []).map((r) => {
    const item: {
      title: string;
      url: string;
      snippet: string;
      source: string | undefined;
      published_at?: string;
    } = {
      title: r.title ?? '',
      url: r.url ?? '',
      // snippet 是页面摘录；description 经常为空。
      snippet: r.snippet || r.description || '',
      source: r.url ? safeHostname(r.url) : undefined,
    };
    if (r.published_at) {
      item.published_at = r.published_at;
    }
    return item;
  });

  const summary =
    items.length > 0
      ? `Keenable returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'Keenable returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
      ],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length, mode: data.mode ?? null },
    },
  };
}

export const keenableProvider: SearchEngine = {
  name: 'keenable',
  roles: ['search'],
  requirement:
    'nothing: search works keyless (1,000 requests/hour per IP, no signup). A free key lifts the hourly cap (100,000 requests/month)',
  // 免密钥搜索什么都不需要，所以它永远可用。密钥只会改变
  // 这次调用打到哪个端点。
  isAvailable: () => true,
  execute: executeKeenableSearch,
};
