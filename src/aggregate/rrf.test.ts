import { describe, expect, it } from 'vitest';
import { rrfFuse } from './rrf.ts';

interface Item {
  title: string;
  url: string;
  snippet: string;
}
const item = (title: string, url: string, snippet = ''): Item => ({ title, url, snippet });

describe('rrfFuse', () => {
  it('ranks a page both sources agree on above either source’s own favourite', () => {
    // The whole point of fusion: agreement beats position in one list.
    const fused = rrfFuse<Item>([
      { engine: 'a', items: [item('A1', 'https://a.example/1'), item('BOTH', 'https://both.example/x')] },
      { engine: 'b', items: [item('B1', 'https://b.example/1'), item('BOTH', 'https://both.example/x')] },
    ]);
    expect(fused[0]?.url).toBe('https://both.example/x');
    expect(fused[0]?.foundIn).toEqual(['a', 'b']);
  });

  it('scores by reciprocal rank with k=60', () => {
    const fused = rrfFuse<Item>([{ engine: 'a', items: [item('X', 'https://x.example/1')] }]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
  });

  it('merges the same page found under tracking parameters into one entry', () => {
    const fused = rrfFuse<Item>([
      { engine: 'a', items: [item('T', 'https://x.example/p?utm_source=feed')] },
      { engine: 'b', items: [item('T', 'https://x.example/p')] },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.foundIn).toEqual(['a', 'b']);
  });

  it('keeps the longest snippet as the representative body', () => {
    const fused = rrfFuse<Item>([
      { engine: 'a', items: [item('T', 'https://x.example/p', 'short')] },
      { engine: 'b', items: [item('T', 'https://x.example/p', 'a much longer snippet')] },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.snippet).toBe('a much longer snippet');
  });

  it('lists the contributing engines once each even when one repeats a page', () => {
    // A provider returning the same URL twice in its own list must not look
    // like two independent sources.
    const fused = rrfFuse<Item>([
      {
        engine: 'a',
        items: [item('T', 'https://x.example/p'), item('T2', 'https://x.example/p?utm_medium=x')],
      },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.foundIn).toEqual(['a']);
  });

  it('is stable across an empty input', () => {
    expect(rrfFuse<Item>([])).toEqual([]);
    expect(rrfFuse<Item>([{ engine: 'a', items: [] }])).toEqual([]);
  });

  it('keeps every page from every list, not just the agreed ones', () => {
    const fused = rrfFuse<Item>([
      { engine: 'a', items: [item('A1', 'https://a.example/1')] },
      { engine: 'b', items: [item('B1', 'https://b.example/1')] },
      { engine: 'c', items: [item('C1', 'https://c.example/1')] },
    ]);
    expect(fused.map((f) => f.url)).toHaveLength(3);
    expect(fused.every((f) => f.foundIn.length === 1)).toBe(true);
  });

  it('treats linkless entries as distinct instead of merging them into one', () => {
    // 五个 provider 都用 `url: r.url ?? ''` 构造条目，所以上游漏一个链接就会
    // 送来空串。若空串被当成「同一页面」，这批互不相干的结果会被合并成一条，
    // foundIn 会声称多个引擎都投了它，虚高的分数还会把它顶到第一位。
    const fused = rrfFuse<Item>([
      { engine: 'a', items: [item('NoLink-1', '')] },
      { engine: 'b', items: [item('NoLink-2', '')] },
      { engine: 'c', items: [item('Linked', 'https://c.example/1')] },
    ]);
    // 三条都在，一条不少。
    expect(fused).toHaveLength(3);
    // foundIn 各归其主：没有任何一条声称被两个引擎共同命中。
    expect(fused.every((f) => f.foundIn.length === 1)).toBe(true);
    expect(fused.map((f) => f.title).sort()).toEqual(['Linked', 'NoLink-1', 'NoLink-2']);
  });

  it('still merges two copies of the same link when one of them lacks a URL', () => {
    // 反向约束：凡是真有 URL 的条目，合并行为必须和以前一模一样。修空 URL
    // 不能顺手把正常的去重也一并关掉。
    const fused = rrfFuse<Item>([
      { engine: 'a', items: [item('Page', 'https://x.example/p?utm_source=fb')] },
      { engine: 'b', items: [item('Page', 'https://x.example/p')] },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.foundIn).toEqual(['a', 'b']);
  });

  it('breaks ties deterministically rather than by input order luck', () => {
    const a = rrfFuse<Item>([
      { engine: 'a', items: [item('A1', 'https://a.example/1')] },
      { engine: 'b', items: [item('B1', 'https://b.example/1')] },
    ]);
    const b = rrfFuse<Item>([
      { engine: 'b', items: [item('B1', 'https://b.example/1')] },
      { engine: 'a', items: [item('A1', 'https://a.example/1')] },
    ]);
    expect(a.map((f) => f.url)).toEqual(b.map((f) => f.url));
  });

  it('lets a caller use a different k without changing the shape', () => {
    const fused = rrfFuse<Item>(
      [{ engine: 'a', items: [item('X', 'https://x.example/1')] }],
      10,
    );
    expect(fused[0]?.score).toBeCloseTo(1 / 11, 10);
  });
});
