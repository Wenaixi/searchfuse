// omp 扩展的结果翻译层。
//
// 这一层是 read_page 能不能用的全部原因：kernel 交给它的是**两种不同结构**
// ——搜索有 `items`、抓页有 `content` + `links`。早先它只遍历 `items`，
// 于是 read_page 对任何页面都只回一句标题（实测同一次抓取 HTTP 侧 9614 字节，
// 工具只返 27 字节），正文被整段丢掉。
//
// 这里直接 import 生产的 toToolResult，不抄一份副本——抄副本的测试在
// 破坏实现后照样绿，那种绿没有意义。
import { describe, expect, it } from 'vitest';
import { toToolResult } from '../omp/extension.ts';

/** 把 kernel 的输出包成它真实会给出的形状。 */
function envelope(mode: 'search' | 'fetch', entry: Record<string, unknown>): string {
  return JSON.stringify({ mode, query: null, url: null, results: [entry] });
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join('\n');

describe('omp 的 toToolResult', () => {
  it('抓页模式把正文交出去，而不是只留标题', () => {
    // 这一条是缺陷的正面锁：破坏回「只读 items」会立刻变红。
    const raw = envelope('fetch', {
      summary: 'Node.js — Node.js Releases (local fetch, 200 OK)',
      content: 'Skip to content\n\n# Node.js Releases\n\nBody text that matters.',
      links: [{ text: 'About', url: 'https://nodejs.org/en/about' }],
      status: 'ok',
    });
    const text = textOf(toToolResult(raw));

    expect(text).toContain('Content:');
    expect(text).toContain('Body text that matters.');
    expect(text).toContain('Links:');
    expect(text).toContain('https://nodejs.org/en/about');
    // 正文长度必须真的进来，而不只是有个 Content 标签。
    expect(text.length).toBeGreaterThan(80);
  });

  it('搜索模式仍然输出命中列表', () => {
    const raw = envelope('search', {
      summary: 'Fused 3 result(s) from 2 engine(s).',
      items: [
        { title: 'Alpha', url: 'https://a.example', snippet: 'first hit' },
        { title: 'Beta', url: 'https://b.example', snippet: 'second hit' },
      ],
      status: 'ok',
    });
    const text = textOf(toToolResult(raw));

    expect(text).toContain('Fused 3 result(s)');
    expect(text).toContain('https://a.example');
    expect(text).toContain('https://b.example');
    expect(text).toContain('first hit');
    // 搜索模式不该凭空冒出抓页段落。
    expect(text).not.toContain('Content:');
  });

  it('降级时把 warnings 原样带上（X 不可达这件事必须可见）', () => {
    // x_search 未登录时 CLI 会返回「答案来自公网」的 warning。翻译层吞掉它，
    // 模型就会照着公网结果答 X 上的事，且没有任何迹象表明这是降级。
    const raw = envelope('search', {
      source: 'web',
      requestedSource: 'x',
      status: 'degraded',
      summary: 'Firecrawl returned 10 ranked result(s) for "test".',
      items: [{ title: 'A', url: 'https://a.example', snippet: 'aa' }],
      warnings: [
        'X itself was not reachable here (Grok Build missing, signed out, or failing), so this came from the public web, which cannot see inside X.',
      ],
      uncertainty: [],
    });
    const text = textOf(toToolResult(raw));

    expect(text).toContain('Warnings:');
    expect(text).toContain('X itself was not reachable');
  });

  it('uncertainty 也要带上', () => {
    const raw = envelope('search', {
      summary: 'Fused.',
      items: [{ title: 'A', url: 'https://a.example' }],
      uncertainty: ['tavily: returned 401'],
      warnings: [],
    });

    expect(textOf(toToolResult(raw))).toContain('Uncertain: tavily: returned 401');
  });

  it('空结果报错，但仍保留原因', () => {
    const raw = JSON.stringify({
      mode: 'search',
      results: [{ status: 'unavailable', warnings: ['all engines failed'] }],
    });
    const result = toToolResult(raw);

    expect(result.isError).toBe(true);
    // 一句原因比一句「所有引擎都没有返回结果」有用得多。
    expect(textOf(result)).toContain('all engines failed');
  });

  it('非 JSON 输出把 kernel 的原文转给模型', () => {
    const result = toToolResult('KERNEL_FAILED: node not found');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('KERNEL_FAILED: node not found');
  });

  it('正文与链接都有上限，不会把宿主撑爆', () => {
    const long = 'x'.repeat(30_000);
    const manyLinks = Array.from({ length: 40 }, (_, i) => ({ text: `L${i}`, url: `https://l${i}.example` }));
    const text = textOf(toToolResult(envelope('fetch', { summary: 'S', content: long, links: manyLinks })));

    // 20_000 上限 + 省略号；允许 summar/link 区段的少量额外字节。
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(30_000);
    // 链接上限 20 条：第 20 条之后的不该出现。
    expect(text).toContain('https://l19.example');
    expect(text).not.toContain('https://l39.example');
  });

  it('warnings 与 uncertainty 超量时只输出前 10 条', () => {
    // 早先没有任何测试喂超过上限的列表，把 stringList 的 cap 删掉照样全绿。
    // 上限的意义是：一个降级运行可能带回几十条引擎失败说明，全塞给模型
    // 会把真正的答案埋在噪音里。
    const many = Array.from({ length: 15 }, (_, i) => `w${i}`);
    const text = textOf(
      toToolResult(
        envelope('search', {
          items: [{ title: 'A', url: 'https://a.example' }],
          warnings: many,
          uncertainty: many.map((w) => `u${w}`),
        }),
      ),
    );

    expect(text).toContain('w9');
    expect(text).not.toContain('w10');
    expect(text).toContain('uw9');
    expect(text).not.toContain('uw10');
  });

  it('抓页只有链接没有正文时仍算成功', () => {
    // 索引页、目录页、登录墙后面的清单：正文抽不出来，但一页链接就是答案。
    // 早先 hasBody 只看 content，这种页面被判 isError，模型会白重试一次。
    const result = toToolResult(
      envelope('fetch', {
        summary: 'A directory page.',
        content: '',
        links: [
          { text: 'Docs', url: 'https://e/docs' },
          { text: 'API', url: 'https://e/api' },
        ],
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('https://e/docs');
  });

  it('链接全是垃圾项时不算拿到内容（判据与输出必须同一份）', () => {
    // 一条 `{nope: 1}` 之类的垃圾不该让空页面被判成功：判据若数原始 links
    // 长度，就会出现「判有内容、却什么都没输出」的裂口。
    const result = toToolResult(
      envelope('fetch', {
        content: '   ',
        links: [{ nope: 1 }, { url: 42 }, null],
      }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('这个页面没有取到内容');
  });

  it('服务错误信封把真实原因说出来，而不是编一句「没有结果」', () => {
    // /v1/read-page 在 400/500 时 body 是 {error:"missing url"}。落进
    // 「没有 items」的分支会输出「所有引擎都没有返回结果」——抓页请求里
    // 根本没有引擎在搜，那句文案本身就是错的，真实原因还消失了。
    const missing = toToolResult(JSON.stringify({ error: 'missing url' }));
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('missing url');
    expect(textOf(missing)).not.toContain('所有引擎都没有返回结果');

    // 抓页链路的错误同样不能退回搜索文案。
    const boom = toToolResult(JSON.stringify({ error: 'firecrawl exploded' }));
    expect(textOf(boom)).toContain('firecrawl exploded');
  });
});
