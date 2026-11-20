// Mod 内核的引擎注册表：用工厂模式把 transport 注入各个引擎。
//
// 与 src/providers/index.ts 相比：
// - 去掉子进程引擎（antigravity-cli、grok-cli）——Mod 沙箱无子进程。
// - 只留 HTTP 搜索引擎（anysearch/tavily/exa/keenable/firecrawl/youcom/searxng）。
// - 没有 local 抓取引擎——WebFetch 用原生兜底。
//
// 工厂接受 FetchFn（由 register 时注入的 $ 适配而来），返回引擎表。
// 引擎对象不直接碰 $，保证可测。

import type { FetchFn } from '../http.ts';

export interface ModEngine {
  name: string;
  /** 这个引擎的搜索工具：收入融合流。 */
  execute: (input: {
    query: string;
    maxResults: number;
    apiKey?: string;
    baseURL?: string;
    timeoutMs?: number;
  }) => Promise<ModEngineResult>;
  /** 这个引擎现在可用吗？ */
  isAvailable: (settings: { apiKey?: string }) => boolean;
}

export interface ModEngineResult {
  items: Array<{ title?: string; url?: string; snippet?: string; source?: string }>;
  warning?: string;
}

/**
 * 构造 Mod 的引擎表。fetchFn 由 register 时注入。
 */
export function createEngines(fetchFn: FetchFn): Record<string, ModEngine> {
  // 每个引擎从 providers/*.ts 拷来的实现通过闭包接上 fetchFn。
  // 等 transport 查证定案后，这里逐个接上。
  const engines: Record<string, ModEngine> = {};

  // anysearch —— 默认引擎（免 key 开箱即用）。
  engines.anysearch = {
    name: 'anysearch',
    execute: async ({ query, maxResults, apiKey, baseURL, timeoutMs }) => {
      // TODO(transport): anysearch 实现接入（http.ts 的 FetchFn 已就位）
      void fetchFn;
      void baseURL;
      void timeoutMs;
      // 占位：真实实现待 transport 定案后从 providers/anysearch.ts 接上。
      void query;
      void maxResults;
      void apiKey;
      return { items: [] };
    },
    isAvailable: () => true,
  };

  return engines;
}