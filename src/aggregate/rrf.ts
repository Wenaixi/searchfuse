import { canonicalUrl } from './canonicalUrl.ts';

/** One engine's ranked list, as the fusion consumes it. */
export interface RankedList<T> {
  engine: string;
  items: T[];
}

/** A fused entry: the representative item plus how the sources ranked it. */
export type Fused<T> = T & {
  /** Reciprocal-rank-fusion score. Higher means more sources ranked it higher. */
  score: number;
  /** The engines that returned this page. More than one means agreement. */
  foundIn: string[];
};

/**
 * Reciprocal Rank Fusion.
 *
 * Each list contributes `1 / (k + rank)` for every page it ranks, and pages
 * are ordered by the sum. Agreement between independent sources therefore
 * beats being one source's top pick: a page placed 1st and 3rd scores higher
 * than a page placed 1st alone. `k` damps the gap between adjacent ranks; 60
 * is the value the method's literature settled on and there is no reason for
 * a caller to tune it here.
 *
 * Items carrying the same canonical URL collapse into one entry. The
 * representative body is the longest snippet, because a truncated copy from
 * one engine should not hide the fuller copy from another.
 *
 * Ties are broken by canonical URL so the order does not depend on which
 * provider happened to answer first, which would make the output differ
 * between runs of the same query.
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
      const key = canonicalUrl(typeof item.url === 'string' ? item.url : '');
      rank += 1;
      // The first mention of a page inside one list is its rank there; a
      // repeat from the same engine must not add a second vote.
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
