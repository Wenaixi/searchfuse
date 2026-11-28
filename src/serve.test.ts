import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServe, toSearxngShape, type ServeHandle } from './serve.ts';
import { cleanupTempDirs, withTempHome } from './testing/helpers.ts';

/**
 * 用 node:http 打本地服务，而不是全局 `fetch`。
 *
 * `vi.stubGlobal('fetch', ...)` 会把测试进程里的全局 fetch 一起换掉，于是测试
 * 自己发的 HTTP 请求也走桩、根本到不了服务端。要验真实端点就必须绕开它。
 */
function httpGet(
  port: number,
  pathAndQuery: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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

// 这一组守的是「端点有没有把冷却控制器传进 runSearch」。
//
// 为什么必须从 HTTP 端点打进去，而不是直接调 runSearch：0.1.1 的缺口恰恰
// 在端点这一层——`startServe` 传了 config 却没传 cooldown，三端（含 omp）
// 跑在生产上，state.json 永远是空的。直接调 runSearch 并手动塞一个控制器，
// 无论端点接线与否都会绿，那是假守护（见 docs/testing.md 第六种假绿）。
describe('端点把冷却控制器接进真实链路', () => {
  let restoreHome: (() => void) | undefined;
  const opened: ServeHandle[] = [];

  afterEach(async () => {
    for (const handle of opened.splice(0)) {
      try {
        await handle.close();
      } catch {
        // 已关闭：不影响结论。
      }
    }
    restoreHome?.();
    restoreHome = undefined;
    vi.unstubAllGlobals();
    cleanupTempDirs();
  });

  it('/search 命中额度墙时把冷却写进该 home 的 state.json', async () => {
    // 隔离到临时 home：这条测试会真的写 state.json，绝不能落在主人真实的状态目录。
    const temp = withTempHome();
    restoreHome = temp.restore;

    // 只留 firecrawl 一个融合引擎，并让它的额度检查必然失败。
    const configDir = path.join(temp.home, '.searchfuse');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        aggregate: { mode: 'rrf' },
        engines: {
          firecrawl: {},
          exa: { enabled: false },
          keenable: { enabled: false },
          anysearch: { enabled: false },
          youcom: { enabled: false },
          searxng: { enabled: false },
          'antigravity-cli': { enabled: false },
        },
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 402,
        statusText: 'Payment Required',
        json: async () => ({}),
        text: async () => '{"error":"You have run out of credits","reason":"credits"}',
      })),
    );

    // 刻意不传 search：让端点走它自己的 runSearch，那条接线才在射程内。
    const handle = await startServe({
      port: 0,
      token: 'test-token',
      idleExitSeconds: 0,
    });
    opened.push(handle);

    // **必须用 node:http 发请求，不能用自己的 `fetch`。** 上面的 stubGlobal
    // 把全局 fetch 换成了假响应，测试里再调 fetch 拿到的就是那个 402 桩，
    // 请求根本不会到达服务端——整条守护会变成「断言自己造的假象」。
    const res = await httpGet(handle.port, '/search?q=probe', 'test-token');
    expect(res.status).toBeGreaterThanOrEqual(400);

    const stateFile = path.join(configDir, 'state.json');
    expect(fs.existsSync(stateFile), '端点没有把冷却落盘，接线断了').toBe(true);
    const recorded = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
      engineCooldowns?: Record<string, unknown>;
    };
    expect(recorded.engineCooldowns?.firecrawl).toBeDefined();
  }, 30_000);

  // `/v1/search` 才是 omp 真正走的路径（见 omp/extension.ts 的 toServeRequest），
  // `/search` 只是 SearXNG 兼容壳。两条各自有一份 cooldown 接线，一条绿不代表
  // 另一条接上了——这正是 0.1.1 那个缺口的形态。
  it('/v1/search 也把冷却写进 state.json', async () => {
    const temp = withTempHome();
    restoreHome = temp.restore;

    const configDir = path.join(temp.home, '.searchfuse');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        aggregate: { mode: 'rrf' },
        engines: {
          exa: { enabled: false },
          keenable: { enabled: false },
          anysearch: { enabled: false },
          youcom: { enabled: false },
          searxng: { enabled: false },
          'antigravity-cli': { enabled: false },
        },
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 402,
        statusText: 'Payment Required',
        json: async () => ({}),
        text: async () => '{"error":"You have run out of credits","reason":"credits"}',
      })),
    );

    const handle = await startServe({ port: 0, token: 'test-token', idleExitSeconds: 0 });
    opened.push(handle);

    const res = await httpGet(handle.port, '/v1/search?q=probe', 'test-token');
    expect(res.status).toBeGreaterThanOrEqual(400);

    const stateFile = path.join(configDir, 'state.json');
    expect(fs.existsSync(stateFile), '/v1/search 没有把冷却落盘，接线断了').toBe(true);
    const recorded = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
      engineCooldowns?: Record<string, unknown>;
    };
    expect(recorded.engineCooldowns?.firecrawl).toBeDefined();
  }, 30_000);
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
