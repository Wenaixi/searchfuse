// Exa 搜索（https://docs.exa.ai）。进程内抓取引擎，只做搜索，
// 形态与 tavily.ts 相同：用内置 fetch 发一个 POST，AbortController 在超时时真正取消请求，
// 不编造相关度评分。Exa 返回带高亮摘要的排序链接，但不写成文答案，
// 所以这里的摘要只是机械拼接，并附一条警告，提示读者直接从 items 取证据。
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import type { EngineRequest, EngineOutput, SearchEngine } from './index.ts';
import { resolveEndpoint } from './endpoint.ts';

const DEFAULT_NUM_RESULTS = 10;
const EXA_DEFAULT_BASE = 'https://api.exa.ai';

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
}

interface ExaResponse {
  results?: ExaResult[];
  /** 本次调用的美元总花费，仅用于诊断。 */
  costDollars?: { total?: number };
}

export async function executeExaSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The exa engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0];
  const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
  if (!apiKey) {
    throw new Error(
      'The exa provider needs an API key. Set EXA_API_KEY, or run: modsearch config set exa.apiKey <key> ($10/month recurring free credit, ~1,400 searches, no card at https://exa.ai)',
    );
  }

  const numResults = options.maxResults ?? DEFAULT_NUM_RESULTS;
  const startedAt = Date.now();

  // 自己持有 abort 信号，这样比任何服务端上限更短的 --timeout 都能在这里生效，
  // 响应体也一并受控，取消时请求真正被拆掉。
  const { response, text } = await requestText(
    'exa',
    resolveEndpoint(options.settings.baseURL, EXA_DEFAULT_BASE, '/search'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query: options.query,
        numResults,
        contents: { highlights: true },
      }),
    },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [...apiKeySecrets, options.settings.baseURL],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    // 网关的错误响应体是外部文本，很容易把 Authorization 头原样回显；
    // 在它进入错误消息之前先做脱敏。
    const detail = redactSecrets(text.trim(), [...apiKeySecrets, options.settings.baseURL]);
    if (response.status >= 500) {
      throw new Error(
        `exa returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`,
      );
    }
    // 余额耗尽属于配额错误，不是密钥损坏：先看响应文本判断，
    // 因为 Exa 可能在多个状态码下返回同一种情况。
    // 冷却层靠这段措辞识别配额类错误。
    if (isQuotaFailureMessage(detail)) {
      throw new ApiKeyFailureError(
        `exa is out of credits: ${detail || `HTTP ${response.status}`}. Add credit at https://exa.ai, or search with another engine.`,
      );
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new ApiKeyFailureError(
        `exa rejected the API key (${response.status}). Fix it: modsearch config set exa.apiKey <key>${detail ? ` (${detail})` : ''}`,
      );
    }
    throw new Error(
      `exa returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`,
    );
  }

  const data = JSON.parse(text) as ExaResponse;

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
      snippet: r.highlights?.[0] ?? '',
      source: r.url ? safeHostname(r.url) : undefined,
    };
    // 防御性处理：只有 Exa 真的返回了日期才带上。
    if (r.publishedDate) {
      item.published_at = r.publishedDate;
    }
    return item;
  });

  const summary =
    items.length > 0
      ? `Exa returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  const result = {
    summary,
    items,
    uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
    // Exa 只排序和给链接，不写综述，所以上面的 summary 是机械拼接的。
    // 形式与本地引擎的「自己读结果」提示相同。
    warnings: [
      'Exa returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
    ],
  };

  return {
    result,
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length, costDollars: data.costDollars?.total ?? null },
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

export const exaProvider: SearchEngine = {
  name: 'exa',
  roles: ['search'],
  requirement: 'set an Exa key ($10/month recurring free credit, ~1,400 searches, no card)',
  isAvailable: (settings, env) =>
    splitApiKeys(settings.apiKey).length > 0 || splitApiKeys(env.EXA_API_KEY).length > 0,
  defaultModel: undefined,
  execute: executeExaSearch,
};
