// 通过 export API（http://export.arxiv.org/api/query）搜索 arXiv。
// 进程内搜索引擎，只做搜索，形态与其他 API 引擎相同。
//
// 不需要密钥。服务方自己说了大约每三秒一次请求；一条搜索链花得远少于这个
// 频率，而请求超时才是防止慢响应拖住整轮运行的东西。
//
// 响应是 Atom XML。这里用一条很窄的正则读取，而不是 XML 解析器：文档小且
// 规整，只需要四个字段，为它引入一个解析器依赖不划算。这种做法失败的表现
// 是字段缺失，而不是字段读错，且下面每个字段都做了校验。
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

/** Atom 会折行包裹文本；API 也把标题和摘要按行缩进。 */
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

/** 从每个 `<entry>` 块里取出那四个字段。 */
function parseEntries(body: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  // 非贪婪匹配，这样相邻条目不会吞掉彼此。
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
  // `all:` 会搜索所有字段；裸词元会被当成字段名来解析。
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
        // 作者放前面：对一篇论文来说，署名行才是告诉模型它在读谁的作品的东西。
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
