import { afterEach, describe, expect, it } from 'vitest';
import { startServe, toSearxngShape, type ServeHandle } from './serve.ts';

const handles: ServeHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

/** 起一个服务，端口 0 让内核分配，避免测试之间抢 7799。 */
async function start(options: Partial<Parameters<typeof startServe>[0]> = {}): Promise<{
  handle: ServeHandle;
  base: string;
}> {
  const handle = await startServe({
    port: 0,
    token: 'test-token',
    idleExitSeconds: 0,
    // 默认不真的去搜网：测试只关心协议形状。
    search: (async () => ({
      mode: 'search',
      query: 'q',
      url: null,
      results: [
        {
          source: 'web',
          requestedSource: 'web',
          engine: 'tavily,exa',
          status: 'ok',
          warnings: [],
          attempts: [],
          durationSeconds: 1,
          items: [{ title: 'T', url: 'https://example.com/1', snippet: 'S' }],
        },
      ],
      meta: { generatedAt: new Date().toISOString(), durationSeconds: 1 },
    })) as never,
    ...options,
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

describe('serve', () => {
  it('/healthz 免鉴权，便于就绪探测', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('其它端点缺 token 时 401', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/search?q=x`);
    expect(res.status).toBe(401);
  });

  it('/search 带 token 时返回 SearXNG 形状', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/search?q=x`, { headers: { authorization: 'Bearer test-token' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.results).toBeDefined();
    expect(body.answers).toBeDefined();
    // omp 依赖这个字段保真上游原因，缺了会退化成泛化错误。
    expect(body.unresponsive_engines).toBeDefined();
  });

  it('/search 命中时 localHits 增加', async () => {
    const { handle, base } = await start();
    expect(handle.localHits()).toBe(0);
    await fetch(`${base}/search?q=x`, { headers: { authorization: 'Bearer test-token' } });
    expect(handle.localHits()).toBe(1);
  });

  it('/__stats 反映 localHits，且需要鉴权', async () => {
    const { base } = await start();
    const unauth = await fetch(`${base}/__stats`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${base}/__stats`, { headers: { authorization: 'Bearer test-token' } });
    const body = (await res.json()) as { localHits: number };
    expect(body.localHits).toBe(0);
  });

  it('/config 返回启用的引擎名，供 omp 解析快捷名', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/config`, { headers: { authorization: 'Bearer test-token' } });
    const body = (await res.json()) as { engines: Array<{ name: string }> };
    expect(Array.isArray(body.engines)).toBe(true);
  });

  it('未知路径 404', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/nope`, { headers: { authorization: 'Bearer test-token' } });
    expect(res.status).toBe(404);
  });
});

describe('toSearxngShape', () => {
  it('把聚合结果映射成 SearXNG 字段，缺 url 的条目丢弃', () => {
    const shaped = toSearxngShape(
      {
        results: [
          {
            engine: 'tavily,exa',
            summary: 'Fused 2 results',
            items: [
              { title: 'A', url: 'https://a.example', snippet: 'sa' },
              { title: 'no url' },
              { url: 'https://b.example', summary: 'sb' },
            ],
            attempts: [{ engine: 'exa', error: 'quota' }],
          },
        ],
      },
      'q',
    );
    expect(shaped.results).toHaveLength(2);
    expect(shaped.results[0]!.url).toBe('https://a.example');
    expect(shaped.results[0]!.engine).toBe('tavily,exa');
    expect(shaped.results[1]!.content).toBe('sb');
    expect(shaped.answers).toEqual(['Fused 2 results']);
    // 失败的引擎必须带出来。
    expect(shaped.unresponsive_engines).toEqual([['exa', 'quota']]);
  });

  it('空结果时 unresponsive_engines 仍带出原因', () => {
    const shaped = toSearxngShape(
      { results: [{ items: [], attempts: [{ engine: 'tavily', error: 'boom' }] }] },
      'q',
    );
    expect(shaped.results).toEqual([]);
    expect(shaped.unresponsive_engines).toEqual([['tavily', 'boom']]);
  });

  it('融合模式下 attempts 为空，失败原因从 uncertainty 补出来', () => {
    // `buildFusedResult` 返回的就是这个形状：attempts 恒为 []，
    // 失败与跳过全在 uncertainty 里（形如 "tavily: 超时" 的整行文字）。
    // 只读 attempts 的话这份列表永远为空，omp 拿不到任何上游原因。
    const shaped = toSearxngShape(
      {
        results: [
          {
            engine: 'tavily,exa',
            status: 'degraded',
            items: [],
            attempts: [],
            uncertainty: [
              'exa: timed out after 8000ms',
              'firecrawl: 处于冷却期，本次未参与（配额恢复后自动回归）',
              'no eligible engine left',
            ],
          },
        ],
      },
      'q',
    );
    // 每条都要保留：能拆出引擎名的拆成二元组，拆不出的整行兜底。
    expect(shaped.unresponsive_engines).toEqual([
      ['exa', 'timed out after 8000ms'],
      ['firecrawl', '处于冷却期，本次未参与（配额恢复后自动回归）'],
      ['searchfuse', 'no eligible engine left'],
    ]);
  });

  it('attempts 有内容时以它为准，不重复读 uncertainty', () => {
    // 两种模式的失败信息不该叠加：链式已经给了精确的 [engine, error]，
    // 再拿 uncertainty 拼一遍会让同一个失败出现两次。
    const shaped = toSearxngShape(
      {
        results: [
          {
            items: [],
            attempts: [{ engine: 'tavily', error: 'boom' }],
            uncertainty: ['tavily: boom'],
          },
        ],
      },
      'q',
    );
    expect(shaped.unresponsive_engines).toEqual([['tavily', 'boom']]);
  });
});
