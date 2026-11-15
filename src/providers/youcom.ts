// You.com（https://you.com/docs）。进程内抓取引擎，只做搜索，形态与
// keenable.ts 相同。它调用免密钥的 agents 端点，You.com 对此的限制是每个
// IP 每天 100 次搜索，且不需要密钥、不需要注册。带密钥的 index 端点尚未
// 接入：没有密钥就无法验证它的请求形状。结果是带摘要的排序页面，没有
// 成文答案，所以 summary 是机械拼出来的。
import { requestText } from '../util/timedRequest.ts';
import { safeHostname } from '../util/host.ts';
import { resolveExplicitProxy } from '../util/explicitProxy.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;
/** 免密钥端点对超过 50 的 count 回 402 Payment Required。 */
const MAX_RESULTS_CEILING = 50;
const YOUCOM_KEYLESS_ENDPOINT = 'https://api.you.com/v1/agents/search';

interface YoucomWebResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

interface YoucomResponse {
  results?: { web?: YoucomWebResult[] };
}

export async function executeYoucomSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The youcom engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CEILING);
  const startedAt = Date.now();

  const url = new URL(YOUCOM_KEYLESS_ENDPOINT);
  url.searchParams.set('query', options.query);
  url.searchParams.set('count', String(maxResults));
  const { response, text } = await requestText(
    'youcom',
    url.toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [],
    resolveExplicitProxy(options.settings.proxy),
  );

  if (!response.ok) {
    const detail = text.trim();
    // 免密钥池由这个 IP 上的所有人共用，所以这里的 429 跟用户配置了什么无关。
    // 它每天重置，下一次运行换个引擎就是了，因此不计入配额冷却。
    if (response.status === 429) {
      throw new Error(
        "youcom's keyless allowance for this IP is used up for the day (100 searches). Search continues with the next engine.",
      );
    }
    throw new Error(
      `youcom returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`,
    );
  }

  const data = JSON.parse(text) as YoucomResponse;

  const items = (data.results?.web ?? []).map((r) => {
    const item: {
      title: string;
      url: string;
      snippet: string;
      source: string | undefined;
      published_at?: string;
    } = {
      title: r.title ?? '',
      url: r.url ?? '',
      // 第一条 snippet 是与查询匹配的摘录；description 则是页面自己的简介。
      snippet: r.snippets?.[0] || r.description || '',
      source: r.url ? safeHostname(r.url) : undefined,
    };
    if (r.page_age) {
      item.published_at = r.page_age;
    }
    return item;
  });

  const summary =
    items.length > 0
      ? `You.com returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'You.com returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
      ],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

export const youcomProvider: SearchEngine = {
  name: 'youcom',
  roles: ['search'],
  requirement: 'nothing: search works keyless (100 searches/day per IP, no signup)',
  isAvailable: () => true,
  execute: executeYoucomSearch,
};
