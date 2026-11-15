/**
 * 从一个可能是坏文本的 URL 里取出主机名，取不到就返回 undefined。
 *
 * 独立成一个模块，是因为七个引擎都在做同一件事：把引擎返回的 URL 变成
 * 条目的 `source` 字段。那段逻辑只有五行，但七个逐字相同的副本意味着
 * 任何一处修正都要改七次，而新加的第八个引擎只会照着复制第八份。
 *
 * 吞掉异常是刻意的：引擎完全可能返回一个写坏的 URL，而一个写坏的 URL
 * 不该让整次搜索失败，它只是没有 source 而已。
 */
export function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
