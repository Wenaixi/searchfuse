// AnySearch 引擎：匿名免 key 档 + 可选 key（无效时自动降级匿名档）。
//
// 参考项目 dsh-free-search 的 lib/engines/anysearch.js 移植而来，关键机制：
//
// 1. 匿名档 —— 不注册、不配 key 也能搜索，额度有限流（适合日常搜索）。
// 2. key 无效自动降级 —— 带 key 请求返回 401/403 时，本次自动改用匿名档
//    重试一次，并在结果里注明「key 被拒，已用匿名档」。这比直接报错更
//    容错：用户填错 key 时搜索仍然可用，只是降级。
//    参考实现还用一个模块级变量记住坏 key 以免反复撞墙，但 dsh-plugin
//    规范禁止模块级可变状态，这里不移植那部分：每次请求都重试 key，
//    key 修好后立刻恢复，无需重启。
// 3. 相关性过滤 —— 结果与查询共享的词汇太少时，整个批次按空结果处理，
//    让融合层有机会换下一个引擎（参考项目 same contract as Bing #112）。
//
// 返回带摘要的排序页面，不含成文答案，所以摘要只是机械拼接。
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import { safeHostname } from '../util/host.ts';
import { redactSecrets } from '../util/redact.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import { resolveEndpoint } from './endpoint.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from '../types.ts';

// transport 依赖注入。Mod 沙箱单 worker 单会话，模块级可变状态安全。
// dsh 侧不 import 本文件，只靠 src/ 里的原版。
type RequestTextLike = (
  label: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
  timeoutMs?: number,
  secrets?: ReadonlyArray<string | undefined | null>,
  explicitProxy?: string | null,
) => Promise<{
  response: { status: number; ok: boolean; statusText: string; headers: { get: (name: string) => string | null } };
  text: string;
}>;

let requestTextImpl: RequestTextLike = null as unknown as RequestTextLike;
let signalTimeoutImpl: (ms: number) => AbortSignal = null as unknown as (ms: number) => AbortSignal;

/** Mod 工厂在 register 时调用，注入 transport。 */
export function setAnySearchDeps(deps: {
  requestText: RequestTextLike;
  signalTimeout: (ms: number) => AbortSignal;
}): void {
  requestTextImpl = deps.requestText;
  signalTimeoutImpl = deps.signalTimeout;
}

// dsh 侧若有需要，可在这里给默认实现（null 时抛错提示要先注入）。
function ensureDeps(): void {
  if (requestTextImpl === null) {
    throw new Error(
      'anysearch transport not injected: call setAnySearchDeps({ requestText, signalTimeout }) first',
    );
  }
}

const DEFAULT_MAX_RESULTS = 10;
/** AnySearch 只接受 1-50 范围内的 max_results。 */
const MAX_RESULTS_CEILING = 50;
const ANYSEARCH_DEFAULT_BASE = 'https://api.anysearch.com';

interface AnySearchResult {
  title?: string;
  url?: string;
  snippet?: string;
}

interface AnySearchResponse {
  code: number;
  message?: string;
  data?: { results?: AnySearchResult[] };
}

/** 查询与结果共享的词汇太少时，这批发结果按空处理。 */
function queryOverlapTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const run of query.match(/[一-鿿]+/g) ?? []) {
    // 单字（年/月/日）几乎出现在任何页面里，只保留二元组。
    if (run.length === 2) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2) tokens.add(word);
  }
  return [...tokens];
}

function looksRelevant(query: string, sources: AnySearchResult[]): boolean {
  const tokens = queryOverlapTokens(query);
  // 纯符号/单字符查询无法可靠判定，放行。
  if (tokens.length === 0) {
    return true;
  }
  const strong = tokens.filter((t) => !/^\d+$/.test(t));
  const usable = strong.length > 0 ? strong : tokens;
  // 短 ASCII 词（gt/max）通常是模型后缀而不是主题；标题强命中需要
  // 中文二元组或 4+ 长度的 ASCII 词。
  const titleStrong = strong.filter((t) => /[一-鿿]/.test(t) || t.length >= 4);
  const titleTokens = titleStrong.length > 0 ? titleStrong : usable;
  const matched = new Set<string>();
  const titleMatched = new Set<string>();
  let relevant = 0;
  for (const source of sources) {
    const title = String(source.title ?? '').toLowerCase();
    const hay = `${title} ${source.snippet ?? ''} ${source.url ?? ''}`.toLowerCase();
    const hits = usable.filter((t) => hay.includes(t.toLowerCase()));
    if (hits.length > 0) {
      relevant += 1;
      for (const hit of hits) matched.add(hit);
      for (const hit of titleTokens) {
        if (title.includes(hit.toLowerCase())) titleMatched.add(hit);
      }
    }
  }
  const enoughSources = relevant >= Math.max(1, Math.ceil(sources.length / 3));
  const enoughTokens =
    matched.size >= Math.min(2, usable.length) || matched.size / usable.length >= 0.5;
  return enoughSources && enoughTokens && titleMatched.size > 0;
}

export async function executeAnySearch(options: EngineRequest): Promise<EngineOutput> {
  ensureDeps();
  if (options.mode === 'fetch') {
    throw new Error('The anysearch engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0] ?? null;
  const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CEILING);
  const startedAt = Date.now();

  const doFetch = async (key: string | null) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return requestTextImpl(
      'anysearch',
      resolveEndpoint(options.settings.baseURL, ANYSEARCH_DEFAULT_BASE, '/v1/search'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: options.query, max_results: maxResults }),
      },
      signalTimeoutImpl(options.timeoutMs),
      options.timeoutMs,
      [...apiKeySecrets, options.settings.baseURL],
      resolveExplicitProxy(options.settings.proxy),
    );
  };

  // 带 key 请求被 401/403 拒绝时，本次自动改用匿名档重试一次。
  let keyRejected = false;
  let { response, text } = await doFetch(apiKey);
  if ((response.status === 401 || response.status === 403) && apiKey) {
    keyRejected = true;
    ({ response, text } = await doFetch(null));
  }

  if (!response.ok) {
    // 网关的错误响应体是外部文本；在它进入错误消息之前先做脱敏。
    const detail = redactSecrets(text.trim(), [...apiKeySecrets, options.settings.baseURL]);
    const message = `anysearch returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`;
    if (response.status >= 500) {
      throw new Error(message);
    }
    if (!apiKey) {
      // 匿名档由所有未注册用户共用，所以这里的 429 与用户自己的配置无关。
      throw new Error(
        response.status === 429
          ? `anysearch's anonymous pool is rate-limited for now. Set a free key for your own quota: searchfuse config set anysearch.apiKey <key>`
          : message,
      );
    }
    // 402 表示配额已耗尽：这属于让冷却层挂起一整天的配额类，而不是反复去撞。
    if (response.status === 402 || isQuotaFailureMessage(detail)) {
      throw new ApiKeyFailureError(
        `anysearch is out of credits (HTTP ${response.status}).${detail ? ` ${detail}` : ''} Add credits at https://anysearch.com, wait for the reset, or search with another engine.`,
      );
    }
    if (response.status === 429) {
      throw new ApiKeyFailureError(message);
    }
    // 带 key 请求返回 401/403，且降级匿名后仍失败：key 无效。
    if (response.status === 401 || response.status === 403) {
      throw new ApiKeyFailureError(
        `anysearch rejected the API key (${response.status}). Fix it: searchfuse config set anysearch.apiKey <key>${detail ? ` (${detail})` : ''}`,
      );
    }
    throw new Error(message);
  }

  const data = JSON.parse(text) as AnySearchResponse;
  if (data.code !== 0) {
    const detail = redactSecrets(data.message ?? '', [...apiKeySecrets, options.settings.baseURL]);
    throw new Error(`anysearch API error: ${detail || data.code}`);
  }

  const results = data.data?.results ?? [];
  const rawItems = results
    .slice(0, maxResults)
    .map((r) => {
      const item: {
        title: string;
        url: string;
        snippet: string;
        source: string | undefined;
      } = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: String(r.snippet ?? '').slice(0, 300),
        source: r.url ? safeHostname(r.url) : undefined,
      };
      return item;
    })
    .filter((r) => r.url !== '');

  // 相关性过滤：整批与查询词汇重叠太少时按空结果处理（参考项目 #112）。
  const items = rawItems.length > 0 && !looksRelevant(options.query, rawItems) ? [] : rawItems;

  const summary =
    items.length > 0
      ? `AnySearch returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty:
        items.length === 0 && rawItems.length > 0
          ? ['AnySearch returned results with no relation to the query. Treat this as no results.']
          : items.length === 0
            ? ['No results found for this query.']
            : [],
      warnings: keyRejected
        ? ['AnySearch key was rejected; used the anonymous tier for this request instead.']
        : [
            'AnySearch returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
          ],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

export const anysearchProvider: SearchEngine = {
  name: 'anysearch',
  roles: ['search'],
  requirement:
    'nothing: search works keyless (anonymous quota, rate-limited). A free key lifts the rate limit',
  // 匿名档免费可用，所以它永远可用。密钥只会让请求带上认证头。
  isAvailable: () => true,
  execute: executeAnySearch,
};