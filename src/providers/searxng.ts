// SearXNG（https://docs.searxng.org/dev/search_api.html）。进程内搜索引擎，
// 只做搜索，形状与其他免密钥 API 引擎一致。
//
// 没有默认主机：公共实例几乎总是返回 403，因为它的 settings.yml 里
// `format: json` 是关的，猜一个主机只会把「配置遗漏」变成「运行时故障」。
// 因此 `baseURL` 是必需的，没有它 isAvailable 就报 false。
//
// 一个实例内部已经扇出到几十个上游引擎，所以这个提供方与其他引擎一样
// 只贡献一份排序列表。不因此调高权重：RRF 融合衡量的是独立来源之间的共识，
// 抬高单一来源的票数只会扭曲它。
import { redactSecrets } from '../util/redact.ts';
import { safeHostname } from '../util/host.ts';
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
    // 健康实例上的 403 绝大多数是格式闸门，而不是访问权限问题，
    // 所以错误消息直接点出该改哪个设置。
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
    // 这里出现 HTML 页面，说明实例忽略了 format=json、返回了网页界面，
    // 这与直接报 403 的那种配置错误是同一回事。
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

export const searxngProvider: SearchEngine = {
  name: 'searxng',
  roles: ['search'],
  requirement:
    'a SearXNG baseURL whose settings.yml enables format: json (public instances usually leave it off and answer 403)',
  // 不存在一个靠谱的默认主机，所以未配置的条目绝不能声称自己可用：
  // 否则链式调度器会被它占住，直到调用时才失败，把配置问题伪装成
  // 运行期问题。
  isAvailable: (settings) => typeof settings.baseURL === 'string' && settings.baseURL.trim() !== '',
  execute: executeSearxngSearch,
};
