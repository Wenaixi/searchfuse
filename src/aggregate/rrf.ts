import { canonicalUrl } from './canonicalUrl.ts';

/** 一个引擎给出的排序结果，正是融合层消费的形状。 */
export interface RankedList<T> {
  engine: string;
  items: T[];
}

/** 融合后的一条：代表条目，加上各来源对它排了第几名。 */
export type Fused<T> = T & {
  /** 倒数排名融合得分。越高说明越多来源把它排得越靠前。 */
  score: number;
  /** 返回过这个页面的引擎。多于一个意味着多个来源互相印证。 */
  foundIn: string[];
};

/**
 * 倒数排名融合（RRF）。
 *
 * 每个列表对它排名的每个页面贡献 `1 / (k + rank)`，页面按得分之和排序。
 * 因此独立来源之间的共识胜过单一来源的头名：一个被排在第 1 和第 3 的页面，
 * 得分高于只在某一家排第 1 的页面。`k` 用来压低相邻名次之间的差距；60 是
 * 这个方法在文献里定下来的取值，调用方没有理由在这里调它。
 *
 * 携带同一规范化 URL 的条目会合并成一条。代表正文取最长的那份摘要，
 * 因为某个引擎截断过的副本不该遮蔽另一个引擎的完整副本。
 *
 * 同分时按规范化 URL 排序，这样顺序不取决于哪个提供方碰巧先应答，
 * 否则同一查询两次运行的结果顺序会不一样。
 */
export function rrfFuse<T extends { url?: string; snippet?: string }>(
  lists: RankedList<T>[],
  k = 60,
): Fused<T>[] {
  const scores = new Map<string, { item: T; score: number; foundIn: string[] }>();

  for (const list of lists) {
    const rankInList = new Map<string, number>();
    let rank = 0;
    for (const item of list.items) {
      rank += 1;
      // 没有 URL 的条目不能被当成「指向同一页面」。
      //
      // 融合的全部依据是「同规范化 URL = 同一页面」，而几个 provider 都用
      // `url: r.url ?? ''` 构造条目：它们的上游一旦漏掉一个链接，这里就会收到
      // 空串。若空串直接交给 canonicalUrl，所有这类条目会共用同一个键，于是
      // 一批互不相干的结果被合并成一条、foundIn 声称多个引擎都投了它、虚假的
      // 共识还把它顶到第一位——丢结果、撒谎、排序失真三件事同时发生。
      //
      // 不知道指向哪里，就只能当作互不相同。合成键用 \0 分段，真实 URL 里
      // 不可能出现这个字节，所以它不会与任何规范化后的 URL 相撞。
      const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
      const key =
        rawUrl === ''
          ? `\0anon\0${list.engine}\0${rank}`
          : canonicalUrl(rawUrl);
      // 一个页面在同一个列表里的首次出现就是它在那里的名次；
      // 同一引擎重复给出同一页，不该算第二票。
      if (rankInList.has(key)) {
        continue;
      }
      rankInList.set(key, rank);
      const contribution = 1 / (k + rank);
      const existing = scores.get(key);
      if (existing === undefined) {
        scores.set(key, { item, score: contribution, foundIn: [list.engine] });
        continue;
      }
      existing.score += contribution;
      if (!existing.foundIn.includes(list.engine)) {
        existing.foundIn.push(list.engine);
      }
      const candidateSnippet = typeof item.snippet === 'string' ? item.snippet : '';
      const heldSnippet = typeof existing.item.snippet === 'string' ? existing.item.snippet : '';
      if (candidateSnippet.length > heldSnippet.length) {
        existing.item = item;
      }
    }
  }

  const entries = [...scores.entries()].map(([key, value]) => ({ key, ...value }));
  entries.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return entries.map((entry) => ({
    ...entry.item,
    score: entry.score,
    foundIn: entry.foundIn,
  }));
}
