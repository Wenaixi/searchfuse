// 社区贡献的引擎（感谢 @mani2001，PR #1），已按引擎契约改造：
// 结果符合 schema 形状、不编造相关度评分、uncertainty 用数组表达。只支持搜索模式。
//
// 这里用内置 fetch 直接与 Tavily REST API 通信。
// 官方 @tavily/core SDK 为了包住一个 POST 请求，拖进了约 30 个生产依赖
// （一条带已知安全公告的 axios 依赖链），所以已弃用。参考
// https://docs.tavily.com/documentation/api-reference/endpoint/search
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import { safeHostname } from '../util/host.ts';
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import type { EngineRequest, EngineOutput, SearchEngine } from './index.ts';
import { resolveEndpoint } from './endpoint.ts';

const DEFAULT_MAX_RESULTS = 8;
const TAVILY_DEFAULT_BASE = 'https://api.tavily.com';

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

export async function executeTavilySearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The tavily engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0];
  const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
  if (!apiKey) {
    throw new Error(
      'The tavily provider needs an API key. Set TAVILY_API_KEY, or run: modsearch config set tavily.apiKey <key> (free tier: 1,000 credits/month at https://app.tavily.com)',
    );
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const startedAt = Date.now();

  // 自己持有 abort 信号，这样比任何服务端上限更短的 --timeout 都能在这里生效，
  // 响应体也一并受控，取消时真正拆掉底层请求，而不是丢下它继续在后台跑。
  const { response, text } = await requestText(
    'tavily',
    resolveEndpoint(options.settings.baseURL, TAVILY_DEFAULT_BASE, '/search'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: options.query,
        search_depth: 'basic',
        include_answer: true,
        max_results: maxResults,
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
    const message = `tavily returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`;
    // 服务端故障不能作为「所选密钥有问题」的证据，哪怕上游错误页恰好提到了配额。
    if (response.status >= 500) {
      throw new Error(message);
    }
    // 月度预算耗尽时 Tavily 返回 432（订阅额度触顶）和 433（按量付费触顶）。
    // 把状态码带进消息，冷却层才能把它读作月度配额类、把引擎挂起一整天
    // （而不是默认的 45 分钟），避免每轮都反复撞同一堵墙。
    if (response.status === 432 || response.status === 433) {
      throw new ApiKeyFailureError(
        `tavily is out of monthly quota (HTTP ${response.status}).${detail ? ` ${detail}` : ''} Add credit at https://app.tavily.com, or search with another engine.`,
      );
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 429 ||
      isQuotaFailureMessage(detail)
    ) {
      throw new ApiKeyFailureError(message);
    }
    throw new Error(message);
  }

  const data = JSON.parse(text) as TavilyResponse;

  const items = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    source: r.url ? safeHostname(r.url) : undefined,
  }));

  const result = {
    summary:
      data.answer ??
      items
        .map((item) => item.snippet)
        .filter(Boolean)
        .join(' '),
    items,
    uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
  };

  return {
    result,
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

export const tavilyProvider: SearchEngine = {
  name: 'tavily',
  roles: ['search'],
  requirement: 'set a Tavily key (free tier: 1,000 credits/month, no card)',
  isAvailable: (settings, env) =>
    splitApiKeys(settings.apiKey).length > 0 || splitApiKeys(env.TAVILY_API_KEY).length > 0,
  defaultModel: 'tavily-basic',
  execute: executeTavilySearch,
};
