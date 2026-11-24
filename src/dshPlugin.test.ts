import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FETCH_RESULT_SCHEMA, SEARCH_RESULT_SCHEMA } from './schema.ts';
import { listEngines } from './providers/index.ts';

const SEARCH_SCHEMA_PATH = new URL('../dsh/search-schema.json', import.meta.url);
const FETCH_SCHEMA_PATH = new URL('../dsh/fetch-schema.json', import.meta.url);

describe('dsh plugin bundle', () => {
  it('ships tool output schemas in lockstep with the source of truth', () => {
    // dsh/index.js cannot import the TS source, so it carries JSON copies;
    // these are the lockstep checks that keep the copies honest.
    const search = JSON.parse(fs.readFileSync(SEARCH_SCHEMA_PATH, 'utf-8'));
    expect(search.properties.summary).toEqual(SEARCH_RESULT_SCHEMA.properties.summary);
    expect(search.properties.items).toEqual(SEARCH_RESULT_SCHEMA.properties.items);
    expect(search.properties.uncertainty).toEqual(SEARCH_RESULT_SCHEMA.properties.uncertainty);
    expect(search.required).toEqual(
      expect.arrayContaining([...SEARCH_RESULT_SCHEMA.required, 'status', 'source']),
    );

    const fetch = JSON.parse(fs.readFileSync(FETCH_SCHEMA_PATH, 'utf-8'));
    expect(fetch).toEqual(FETCH_RESULT_SCHEMA);
  });

  it('keeps the card engine list in lockstep across the host and browser halves', () => {
    // dsh/index.js and dsh/client.js each carry their own copy of the engine
    // list: the browser half is a hand-written bundle that cannot import the
    // TypeScript source, so the duplication is structural rather than an
    // oversight. Nothing else guards it, and a new engine added to one half
    // only would show up in the card as an engine the host then refuses, or
    // as an engine the host accepts that the card never offers.
    const host = fs.readFileSync(new URL('../dsh/index.js', import.meta.url), 'utf-8');
    const client = fs.readFileSync(new URL('../dsh/client.js', import.meta.url), 'utf-8');
    const listFrom = (source: string, constant: string): string[] => {
      // The host half is a module using `const`; the browser half is a
      // hand-written bundle using `var`, so the pattern accepts both.
      const match = source.match(new RegExp(`(?:const|var) ${constant} = \\[([^\\]]+)\\]`));
      if (!match?.[1]) throw new Error(`${constant} not found`);
      return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    };
    expect(listFrom(client, 'ENGINES')).toEqual(listFrom(host, 'CARD_ENGINES'));
  });

  it('keeps the registered engines in lockstep with the card list', () => {
    // A registered engine the card does not offer is unconfigurable from the
    // web UI; a card entry with no registration is a row that cannot work.
    const host = fs.readFileSync(new URL('../dsh/index.js', import.meta.url), 'utf-8');
    const card = host.match(/const CARD_ENGINES = \[([^\]]+)\]/)?.[1] ?? '';
    const offered = [...card.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    const registered = listEngines();
    expect(registered.filter((name) => !offered.includes(name))).toEqual([]);
  });

  it('keeps the default-off engine list in lockstep with the host half', () => {
    // 「默认不激活、但界面上可以打开」这条规则住在 src/config.ts 的
    // OFF_UNLESS_ENABLED，而宿主那半带着一份副本（它不能 import TypeScript
    // 源码）。副本漂移时卡片会显示一种状态而宿主执行另一种，用户看不到报错，
    // 只会发现「我明明打开过它」。
    const source = fs.readFileSync(new URL('./config.ts', import.meta.url), 'utf-8');
    const host = fs.readFileSync(new URL('../dsh/index.js', import.meta.url), 'utf-8');
    const block = source.match(/OFF_UNLESS_ENABLED[^=]*=\s*\{([^}]*)\}/s)?.[1] ?? '';
    // 键可能带引号（`'antigravity-cli'`）也可能不带（`youcom`），两种都要抓：
    // 只抓裸键名会静默漏掉带引号的那部分，于是断言比它看起来的更弱。
    const fromSource = [...block.matchAll(/['"]?([A-Za-z0-9_-]+)['"]?\s*:/g)].map((m) => m[1]);
    const listFrom = (text: string, name: string): string[] => {
      const m = text.match(new RegExp(`(?:const|var) ${name} = \\[([^\\]]+)\\]`));
      if (!m?.[1]) throw new Error(`${name} not found`);
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
    };
    expect(fromSource.length).toBeGreaterThan(0);
    expect(listFrom(host, 'DEFAULT_OFF_ENGINES')).toEqual(fromSource);
  });

  it('wires the bundle manifest to the patch and the patch to the plugin', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as {
      dsh?: {
        bundle?: { patch?: string };
        client?: { inject?: string[]; platform?: string; immediately?: boolean };
      };
      exports?: Record<string, string>;
      files?: string[];
    };
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    // The browser half rides the same manifest: without `dsh.client` the host
    // never loads dsh/client.js and the settings card silently never exists.
    expect(pkg.dsh?.client).toEqual({ inject: [], platform: 'web', immediately: true });
    expect(pkg.exports?.['.']).toBe('./dsh/index.js');
    expect(pkg.exports?.['./dsh']).toBe('./dsh/index.js');
    expect(pkg.exports?.['./client']).toBe('./dsh/client.js');
    expect(pkg.files).toContain('dsh');
    expect(pkg.files).toContain('cordis.patch.yml');
    const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf-8');
    expect(patch).toContain("name: '@wenaixi/searchfuse'");
    expect(patch).toContain('searchProvider: modsearch');
  });

  it('keeps every key of the base web row when repointing search (#43)', () => {
    // A patch row replaces the target row's whole config. dsh-base ships the
    // web row as `searchProvider: deepseek-official` + `fetchProvider: http`,
    // so dropping fetchProvider leaves two usable fetch backends once the host
    // also registers deepseek-fetch-api, and web_fetch fails as ambiguous.
    const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf-8');
    const webRow = /^- id: web\n {2}config:\n((?: {4}\S.*\n)+)/m.exec(patch);
    expect(webRow).not.toBeNull();
    const config = Object.fromEntries(
      webRow![1]
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/:\s*/)),
    );
    expect(config).toEqual({ searchProvider: 'modsearch', fetchProvider: 'http' });
  });
});

interface RegisteredTool {
  name: string;
  parameters: unknown;
  output: {
    schema: unknown;
    render: (args: unknown, value: never) => Array<{ type: string; text: string }>;
    presentationMeta?: (args: unknown, value: never) => { sources: unknown[] };
  };
  presentResult?: (
    args: unknown,
    result: { content: unknown[]; isError: boolean; meta?: { sources: unknown[] } },
  ) => { card: string; kind: string; sources: unknown[] } | undefined;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
}

interface RegisteredProvider {
  id: string;
  available: () => boolean;
  search: (
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ) => Promise<{ content: string; sources: Array<Record<string, unknown>>; truncated: boolean }>;
}

async function load(config?: Record<string, unknown>) {
  // dsh/index.js 是 tsc 从 index.ts 编译出来的产物，类型就在同目录，
  // 所以这里不需要再压制任何东西。
  const plugin = (await import('../dsh/index.js')) as {
    apply: (ctx: unknown, config?: Record<string, unknown>) => void;
  };
  const tools = new Map<string, RegisteredTool>();
  const providers: RegisteredProvider[] = [];
  const ctx = {
    tools: {
      register: (definition: RegisteredTool) => {
        tools.set(definition.name, definition);
      },
    },
    web: {
      registerSearchProvider: (provider: RegisteredProvider) => {
        providers.push(provider);
      },
    },
  };
  plugin.apply(ctx as never, config);
  return { tools, providers };
}

/** The named registered tool, or a loud failure when registration skipped it. */
function toolNamed(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const definition = tools.get(name);
  if (!definition) {
    throw new Error(`tool ${name} was not registered`);
  }
  return definition;
}

const created: string[] = [];
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
// 真实家目录的快照：多个用例会把 USERPROFILE 指向临时目录（插件按
// homedir() 找 runtime.json），所以每个用例结束时必须还原到这一份，而不是
// 「上一个用例碰巧留下的值」。
const INITIAL_HOME = process.env.USERPROFILE;

afterEach(async () => {
  if (stubServer !== undefined) {
    const server = stubServer;
    stubServer = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  stubServe = undefined;
  if (INITIAL_HOME === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = INITIAL_HOME;
  }
  originalHome = undefined;
  delete process.env.MODSEARCH_DSH_CLI;
  if (originalElectronRunAsNode === undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } else {
    process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  }
  Reflect.deleteProperty(process.versions, 'electron');
  while (created.length > 0) {
    fs.rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

/**
 * 起一个桩 HTTP 服务，并把它的端口与 token 写进临时 HOME 的 runtime.json。
 *
 * 插件现在走 `HTTP -> 唤醒 -> 重试` 的两级路径（曾经还有第三级「搜完就
 * spawn 一个一次性 kernel」，已移除），所以验证点从「CLI 的 stdout」挪到了
 * 「服务端的响应」。这个桩服务记录收到的每个请求，测试据此断言参数转发。
 */
interface StubServe {
  /** 插件会发到这个端口；未定义表示 runtime.json 刻意缺失。 */
  requests: Array<{ path: string; params: URLSearchParams; authorization: string | undefined }>;
  /** 改动下一次响应的行为。默认按已登记的响应表作答。 */
  respond: (status: number, body: string) => void;
}

let stubServe: StubServe | undefined;
let stubServer: import('http').Server | undefined;
let originalHome: string | undefined;

/** 起桩服务并让插件指向它；测试只需要给一份响应。 */
async function serveWith(status: number, body: unknown): Promise<StubServe> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const stub = startStubServe({ path: '/v1/search', status, body: payload });
  stubServe = stub;
  await pointPluginAtStub();
  return stub;
}

function startStubServe(endpoint: { path: string; status: number; body: string }): StubServe {
  const requests: StubServe['requests'] = [];
  const state = { status: endpoint.status, body: endpoint.body };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      path: url.pathname,
      params: url.searchParams,
      authorization: req.headers.authorization as string | undefined,
    });
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(state.body);
  });
  const stub: StubServe = {
    requests,
    respond: (status: number, body: string) => {
      state.status = status;
      state.body = body;
    },
  };
  stubServer = server;
  return stub;
}

/** 把桩服务的地址写进临时 HOME，让插件读得到。 */
async function pointPluginAtStub(): Promise<void> {
  const port = await new Promise<number>((resolve) => {
    stubServer!.listen(0, '127.0.0.1', () => {
      resolve((stubServer!.address() as import('node:net').AddressInfo).port);
    });
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modsearch-dsh-home-'));
  created.push(home);
  fs.mkdirSync(path.join(home, '.searchfuse'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.searchfuse', 'runtime.json'),
    JSON.stringify({ port, token: 'test-token' }),
  );
  originalHome = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
}

/** Point MODSEARCH_DSH_CLI at a node script whose stdout is this envelope. */
function fakeCli(body: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsearch-dsh-cli-'));
  created.push(dir);
  const file = path.join(dir, 'cli.js');
  fs.writeFileSync(file, body);
  process.env.MODSEARCH_DSH_CLI = file;
}

function envelopeCli(entry: Record<string, unknown>): void {
  fakeCli(`console.log(JSON.stringify({ results: [${JSON.stringify(entry)}] }))`);
}

const okSearchEntry = {
  source: 'web',
  requestedSource: 'web',
  engine: 'antigravity-cli',
  status: 'ok',
  warnings: [],
  attempts: [{ engine: 'antigravity-cli', ok: true, durationSeconds: 3 }],
  durationSeconds: 3,
  summary: 'What the web says.',
  items: [
    { title: 'A', url: 'https://a.example', snippet: 'sa', published_at: '2026-08-01' },
    { title: 'B', url: 'https://b.example', snippet: 'sb' },
    { title: 'junk-without-url', snippet: 'dropped' },
  ],
  uncertainty: ['dates approximate'],
};

describe('dsh web search provider', () => {
  it('reaches the service over HTTP instead of spawning a one-off kernel', async () => {
    // 三级回退已收敛成两级：HTTP -> 唤醒 -> 重试。这条用例钉住第一级就命中，
    // 也就是服务在跑时不会再起任何子进程。
    const stub = await serveWith(200, { results: [okSearchEntry] });
    const { providers } = await load();
    await expect(providers[0].search({ query: 'anything' })).resolves.toMatchObject({
      content: expect.stringContaining('What the web says.'),
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].path).toBe('/v1/search');
    expect(stub.requests[0].params.get('q')).toBe('anything');
    expect(stub.requests[0].authorization).toBe('Bearer test-token');
  });

  it('maps the envelope to the seam result shape', async () => {
    const stub = await serveWith(200, { results: [okSearchEntry] });
    const { providers } = await load();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('modsearch');
    expect(providers[0].available()).toBe(true);
    const result = await providers[0].search({ query: 'anything', maxResults: 5 });
    expect(result.content).toContain('What the web says.');
    expect(result.content).toContain('Uncertain: dates approximate');
    expect(result.truncated).toBe(false);
    // Max results travels as a query parameter; junk without a URL is dropped
    // and published_at becomes the seam's camelCase.
    expect(stub.requests[0].params.get('max')).toBe('5');
    expect(result.sources).toEqual([
      { title: 'A', url: 'https://a.example', snippet: 'sa', publishedAt: '2026-08-01' },
      { title: 'B', url: 'https://b.example', snippet: 'sb' },
    ]);
  });

  it('names the attempt trail when every engine failed', async () => {
    await serveWith(200, {
      results: [
        {
          ...okSearchEntry,
          status: 'unavailable',
          summary: '',
          items: [],
          attempts: [{ engine: 'antigravity-cli', ok: false, error: 'not signed in' }],
        },
      ],
    });
    const { providers } = await load();
    await expect(providers[0].search({ query: 'anything' })).rejects.toThrow(
      /antigravity-cli: not signed in.*doctor/s,
    );
  });

  it('carries the service error body instead of hiding it behind "unreachable"', async () => {
    // 服务端 5xx 的正文里有逐引擎的尝试轨迹；旧路径靠 CLI 的 stderr 表达
    // 这件事，HTTP 路径必须把同一份信息带出来。
    await serveWith(500, { error: 'Every engine for the web source failed.' });
    const { providers } = await load();
    await expect(providers[0].search({ query: 'anything' })).rejects.toThrow(
      /500.*Every engine for the web source failed/s,
    );
  });

  it('says how to reinstall when the CLI build is missing, as after a GitHub source install', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsearch-dsh-cli-'));
    created.push(dir);
    // 必须同时屏蔽真实家目录：那台机器上跑着一个真实服务时，第一级 HTTP
    // 就会成功，这个用例根本走不到检查构建的那一步。
    process.env.USERPROFILE = dir;
    process.env.MODSEARCH_DSH_CLI = path.join(dir, 'dist', 'main.js');
    const { providers } = await load();
    await expect(providers[0].search({ query: 'anything' })).rejects.toThrow(
      /build is missing.*GitHub.*@wenaixi\/searchfuse/s,
    );
  });

  it('reports unreachable rather than spawning anything when no service answers', async () => {
    // runtime.json 缺失 + 唤醒失败（这里用不存在的 CLI 制造失败），
    // 结果必须是一句可行动的报错，而不是悄悄退化成一个并行实现。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modsearch-dsh-nohome-'));
    created.push(home);
    process.env.USERPROFILE = home;
    process.env.MODSEARCH_DSH_CLI = path.join(home, 'definitely-missing-cli.js');
    const { providers } = await load();
    await expect(providers[0].search({ query: 'anything' })).rejects.toThrow(
      /build is missing.*GitHub/s,
    );
  });
});

describe('dsh CLI budgets', () => {
  // 预算现在以查询参数的形式下发到服务端；服务端读不到它们就会退回自己的
  // 默认值，卡片里的 aggregate.deadlineMs 也就会变成哑设置。
  const budgetOf = (stub: StubServe) => ({
    timeout: stub.requests[0]?.params.get('timeout') ?? undefined,
    deadline: stub.requests[0]?.params.get('deadline') ?? undefined,
  });

  it('passes the built-in budgets when neither the plugin nor the file sets one', async () => {
    // Pinned explicitly so this case does not depend on what the ambient
    // ~/.searchfuse/config.json happens to hold: the point is the built-in
    // default, not the machine it runs on.
    const stub = await serveWith(200, { results: [okSearchEntry] });
    const { providers } = await load({ providerTimeoutMs: 40_000, providerDeadlineMs: 55_000 });
    await providers[0].search({ query: 'anything' });
    // One engine may take 40s, the whole chain 55s. Even an engine that
    // ignores its own timeout is stopped 5s past it, which leaves a fast
    // fallback 10s, and the run ends before the host's 60s abort.
    expect(budgetOf(stub).timeout).toBe('40000');
    expect(budgetOf(stub).deadline).toBe('55000');
  });

  it('bounds the per-engine budget by the run budget it sends', async () => {
    const stub = await serveWith(200, { results: [okSearchEntry] });
    const { providers } = await load();
    await providers[0].search({ query: 'anything' });
    const deadline = Number(budgetOf(stub).deadline);
    const timeout = Number(budgetOf(stub).timeout);
    expect(Number.isFinite(deadline)).toBe(true);
    // The per-engine budget never exceeds the run budget.
    expect(timeout).toBeLessThanOrEqual(deadline);
  });

  it('lets the plugin config move both provider budgets', async () => {
    const stub = await serveWith(200, { results: [okSearchEntry] });
    const { providers } = await load({ providerTimeoutMs: 30_000, providerDeadlineMs: 50_000 });
    await providers[0].search({ query: 'anything' });
    expect(budgetOf(stub).timeout).toBe('30000');
    expect(budgetOf(stub).deadline).toBe('50000');
  });

  it('bounds x_search and read_page by a run deadline inside their own backstop', async () => {
    const stub = await serveWith(200, { results: [okSearchEntry] });
    const { tools } = await load({ xSearch: true });
    for (const [name, args] of [
      ['x_search', { query: 'anything' }],
      ['read_page', { url: 'https://a.example' }],
    ] as const) {
      stub.requests.length = 0;
      const tool = toolNamed(tools, name) as RegisteredTool & { timeoutMs: number };
      await tool.execute(args, {});
      const { timeout, deadline } = budgetOf(stub);
      expect(timeout).toBeDefined();
      expect(deadline).toBeDefined();
      const engineTimeout = Number(timeout);
      const deadlineMs = Number(deadline);
      // A slow first engine leaves time for the next, and the whole run ends
      // before the harness backstop fires its bare abort.
      expect(engineTimeout).toBeLessThan(deadlineMs);
      expect(deadlineMs).toBeLessThan(tool.timeoutMs);
    }
  });
});

describe('dsh x_search tool', () => {
  it('returns evidence plus provenance as the canonical value', async () => {
    const stub = await serveWith(200, {
      results: [{ ...okSearchEntry, source: 'x', requestedSource: 'x', engine: 'grok-cli' }],
    });
    const { tools } = await load({ xSearch: true });
    const tool = toolNamed(tools, 'x_search');
    const value = await tool.execute({ query: 'what is @dev saying' }, {});
    expect(value).toEqual({
      status: 'ok',
      source: 'x',
      summary: 'What the web says.',
      items: okSearchEntry.items,
      uncertainty: ['dates approximate'],
    });
  });

  it('marks a web stand-in answer as degraded in value and render', async () => {
    await serveWith(200, {
      results: [{ ...okSearchEntry, requestedSource: 'x', status: 'degraded' }],
    });
    const { tools } = await load({ xSearch: true });
    const tool = toolNamed(tools, 'x_search');
    const value = await tool.execute({ query: 'reactions to the launch' }, {});
    expect(value.status).toBe('degraded');
    expect(value.source).toBe('web');
    const [block] = tool.output.render({}, value as never);
    expect(block.text).toContain('second-hand');
    expect(block.text).toContain('1. A (2026-08-01) — https://a.example');
  });

  it('projects citation sources for the native web card', async () => {
    const { tools } = await load({ xSearch: true });
    const tool = toolNamed(tools, 'x_search');
    const value = {
      status: 'ok',
      source: 'x',
      summary: 's',
      items: okSearchEntry.items,
      uncertainty: [],
    };
    const meta = tool.output.presentationMeta?.({}, value as never);
    expect(meta?.sources).toHaveLength(2);
    const card = tool.presentResult?.({}, { content: [], isError: false, meta });
    expect(card).toEqual({
      card: 'web',
      kind: 'search',
      sources: meta?.sources,
      truncated: false,
    });
    expect(tool.presentResult?.({}, { content: [], isError: true })).toBeUndefined();
  });

  it('rejects an empty query before spawning anything', async () => {
    const { tools } = await load({ xSearch: true });
    await expect(toolNamed(tools, 'x_search').execute({ query: '  ' }, {})).rejects.toThrow(
      /non-empty string "query"/,
    );
  });
});

describe('dsh read_page tool', () => {
  // dsh exposes its own web_fetch by default (#47). Both tools take a URL, so
  // the description has to tell the model which one fits which job.
  it('tells the model when to pick read_page over web_fetch', async () => {
    const { tools } = await load();
    const { description } = toolNamed(tools, 'read_page') as unknown as { description: string };
    expect(description).toMatch(/web_fetch/);
    expect(description).toMatch(/JavaScript/);
    expect(description).toMatch(/raw/i);
  });

  it('returns the fetch evidence fields as the canonical value', async () => {
    const stub = await serveWith(200, {
      results: [
        {
          source: 'web',
          requestedSource: 'web',
          engine: 'antigravity-cli',
          status: 'ok',
          warnings: ['Fetched through Firecrawl in the cloud.'],
          attempts: [],
          durationSeconds: 2,
          summary: 'The page in one line.',
          content: 'Full extracted content.',
          links: [{ text: 'docs', url: 'https://a.example/docs' }],
          uncertainty: [],
        },
      ],
    });
    const { tools } = await load();
    const tool = toolNamed(tools, 'read_page');
    const value = await tool.execute({ url: 'https://a.example', query: 'rate limits' }, {});
    // 读页也走同一条 HTTP 通道，且 url 以参数形式转发。
    expect(stub.requests[0].path).toBe('/v1/read-page');
    expect(stub.requests[0].params.get('url')).toBe('https://a.example');
    expect(value).toEqual({
      summary: 'The page in one line.',
      content: 'Full extracted content.',
      links: [{ text: 'docs', url: 'https://a.example/docs' }],
      uncertainty: [],
      warnings: ['Fetched through Firecrawl in the cloud.'],
    });
    const [block] = tool.output.render({}, value as never);
    expect(block.text).toContain('Full extracted content.');
    expect(block.text).toContain('- docs — https://a.example/docs');
    expect(block.text).toContain('Fetched through Firecrawl in the cloud.');
  });

  it('rejects a non-http url before spawning anything', async () => {
    const { tools } = await load();
    const tool = toolNamed(tools, 'read_page');
    await expect(tool.execute({ url: 'file:///etc/passwd' }, {})).rejects.toThrow(/http\(s\)/);
  });
});

type RouteHandler = (req: unknown, res: unknown) => Promise<void>;

interface Namespace {
  ns: string;
  schema: ((value: unknown) => unknown) & { toJSON: () => unknown };
  options: unknown;
}

/**
 * A host that offers webServer and settings on scoped injects, like dsh's web
 * profile. Each scope collects what its `effect` calls return and runs them
 * on `unload()`, the way cordis tears down a plugin that is switched off, and
 * the route table refuses a second route on one path, as dsh's does. The
 * webServer outlives the plugin, so a later `apply` models switching it back
 * on. `settings` replaces the service: dsh before 0.1.7 served the namespace
 * registry recorded here, 0.1.7 serves Config forms with no register at all,
 * and `null` is a host that serves no settings service.
 */
function house(options: { settings?: Record<string, unknown> | null } = {}) {
  const routes: Record<string, RouteHandler> = {};
  const namespaces: Namespace[] = [];
  const injected: string[][] = [];
  const tools = new Map<string, RegisteredTool>();
  const providers: RegisteredProvider[] = [];
  let disposers: Array<() => void> = [];
  const scope = (services: Record<string, unknown>) => ({
    ...services,
    effect: (execute: () => () => void) => {
      const dispose = execute();
      disposers.push(dispose);
      return dispose;
    },
  });
  const webServer = {
    register: (route: { name: string; path: string; handler: RouteHandler }) => {
      if (Object.hasOwn(routes, route.name)) {
        throw new Error(`webserver: duplicate exact route "${route.path}"`);
      }
      routes[route.name] = route.handler;
      return () => {
        delete routes[route.name];
      };
    },
  };
  const ctx = {
    tools: {
      register: (definition: RegisteredTool) => {
        tools.set(definition.name, definition);
        // 真宿主返回一个精确的撤销句柄，工具因此能单独撤掉。这个假宿主也得
        // 这么做：否则「先撤旧的再注册新的」这条路径在测试里根本走不到。
        const undo = () => {
          tools.delete(definition.name);
        };
        // 真宿主的 register 内部是 `this.layers.effect(this.ctx, ...)`，也就是
        // 把工具的生命周期绑在**调用方的 fiber** 上：插件卸载时工具自动消失，
        // 插件不需要自己登记。假宿主必须复现这一点，否则「卸载后残留工具」这种
        // 真实环境里不存在的问题会在验收里冒出来，把注意力引向错误的地方。
        disposers.push(undo);
        return undo;
      },
    },
    web: {
      registerSearchProvider: (provider: RegisteredProvider) => {
        providers.push(provider);
      },
    },
    inject: (deps: string[], run: (scope: unknown) => void) => {
      injected.push(deps);
      if (deps.includes('webServer')) {
        run(scope({ webServer }));
      }
      if (deps.includes('settings') && options.settings !== null) {
        run(
          scope({
            settings: options.settings ?? {
              register: (ns: string, schema: Namespace['schema'], registered: unknown) => {
                namespaces.push({ ns, schema, options: registered });
                return { get: () => ({}), watch: () => () => {} };
              },
            },
          }),
        );
      }
    },
  };
  const unload = () => {
    for (const dispose of disposers.splice(0).reverse()) {
      dispose();
    }
    disposers = [];
  };
  return { routes, namespaces, injected, tools, providers, ctx, unload };
}

async function callRoute(
  handler: RouteHandler,
  req: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let body = '';
  await handler(
    { headers: { host: '127.0.0.1:3080' }, ...req },
    {
      writeHead: (code: number) => {
        status = code;
        return { end: () => {} };
      },
      end: (chunk: string) => {
        body = chunk ?? '';
      },
    },
  );
  return { status, body: body === '' ? {} : JSON.parse(body) };
}

/** A POST request whose body is this JSON payload. */
function postOf(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    method: 'POST',
    url: '/searchfuse/config',
    // 路由强制 application/json：跨站「简单请求」只能用 text/plain 等三种
    // content-type，要求 JSON 就等于让它在 CORS 预检阶段被拒。
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(payload));
    },
  };
}

/** Run against a temporary HOME holding this config file. */
async function withConfig(
  contents: unknown,
  run: (handler: RouteHandler, file: string, stage: ReturnType<typeof house>) => Promise<void>,
  pluginConfig: Record<string, unknown> = {},
): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modsearch-home-'));
  const file = path.join(home, '.searchfuse', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  // 只记录宿主原有的相关变量以便还原；是否清空由用例自己决定，
  // 因为部分用例需要在 withConfig 之外注入环境密钥来验证 env 分支。
  const KEY_ENV = [
    'EXA_API_KEY', 'EXA_BASE_URL',
    'TAVILY_API_KEY', 'TAVILY_BASE_URL',
    'FIRECRAWL_API_KEY', 'FIRECRAWL_BASE_URL',
    'KEENABLE_API_KEY', 'KEENABLE_BASE_URL',
    'ANYSEARCH_API_KEY', 'ANYSEARCH_BASE_URL',
  ];
  const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const realKeys = KEY_ENV.map((k) => [k, process.env[k]] as const);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const plugin = (await import('../dsh/index.js')) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void;
    };
    const stage = house();
    plugin.apply(stage.ctx as never, pluginConfig);
    await run(stage.routes['modsearch-config'], file, stage);
  } finally {
    process.env.HOME = realHome.HOME;
    process.env.USERPROFILE = realHome.USERPROFILE;
    for (const [k, v] of realKeys) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('本地服务的状态与拉起动作', () => {
  it('摘要里带上服务在不在', async () => {
    await withConfig({}, async (handler) => {
      const { status, body } = await callRoute(handler, { method: 'GET', url: '/searchfuse/config' });
      expect(status).toBe(200);
      expect(body).toHaveProperty('serve');
      // 临时 HOME 下没有 runtime.json，所以确定性地是「不在跑」。
      // 这条同时守着「服务状态必须真的被算出来」——若 serve 段被写成
      // 常量或忘记 await（于是下发一个 Promise），这里都会红。
      expect(body.serve).toEqual({ running: false });
    });
  });

  it('action=ensureServe 是独立动作，不写配置文件', async () => {
    await withConfig({ engine: 'exa' }, async (handler, file) => {
      const before = fs.readFileSync(file, 'utf-8');
      // 注入一个立刻以退出码 1 结束的假 CLI：`startServe` 会立刻判失败并返回，
      // 不会留下常驻服务。这条验的是「动作被路由识别且走了独立分支」，
      // 不是「服务真的起得来」——后者由 src/serveEnsure.test.ts 守着。
      const fakeCli = path.join(os.tmpdir(), `sf-fake-cli-${Date.now()}-${Math.random()}.cjs`);
      fs.writeFileSync(fakeCli, 'process.exit(1);\n', 'utf-8');
      const savedCli = process.env.SEARCHFUSE_SERVE_CLI;
      process.env.SEARCHFUSE_SERVE_CLI = fakeCli;
      try {
        const { status, body } = await callRoute(handler, postOf({ action: 'ensureServe' }));
        // 动作被识别：返回的是结果对象，不是完整摘要（后者会带 engines）。
        expect(status).toBe(200);
        expect(body).not.toHaveProperty('engines');
        expect(body).toHaveProperty('ok');
        // 关键断言：配置文件一个字节都没动。
        expect(fs.readFileSync(file, 'utf-8')).toBe(before);
      } finally {
        if (savedCli === undefined) delete process.env.SEARCHFUSE_SERVE_CLI;
        else process.env.SEARCHFUSE_SERVE_CLI = savedCli;
        fs.rmSync(fakeCli, { force: true });
      }
    });
  });
});

describe('dsh settings card route', () => {
  // The card is the browser half; this covers the host half it talks to,
  // where the API keys live. Every assertion here is about a key not leaving,
  // not being lost, and no other setting moving underneath the save.
  it('never puts an API key on the wire, only whether one is stored', async () => {
    // 宿主机上的 EXA_API_KEY 会让 exa.hasKey 变 true。本用例断言的是
    // 「文件里没有、环境里也没有」的基线，所以先摘掉它再还原。
    const savedExaKey = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      await withConfig(
      {
        engine: 'tavily',
        engines: {
          tavily: { apiKey: 'tvly-secret', baseURL: 'https://gw.example' },
          exa: { model: 'unused', enabled: false },
        },
      },
      async (handler) => {
        const { status, body } = await callRoute(handler, {
          method: 'GET',
          url: '/searchfuse/config',
        });
        expect(status).toBe(200);
        expect(JSON.stringify(body)).not.toContain('tvly-secret');
        expect(body.engine).toBe('tavily');
        const engines = body.engines as Record<
          string,
          { hasKey: boolean; keySource: string | null; baseURL: string; enabled: boolean }
        >;
        expect(engines.tavily.hasKey).toBe(true);
        expect(engines.tavily.keySource).toBe('file');
        expect(engines.tavily.baseURL).toBe('https://gw.example');
        expect(engines.tavily.enabled).toBe(true);
        expect(engines.exa.hasKey).toBe(false);
        expect(engines.exa.keySource).toBe(null);
        expect(engines.exa.enabled).toBe(false);
      },
    );
    } finally {
      if (savedExaKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = savedExaKey;
    }
  });

  it('does not report comma-only API key settings as stored keys', async () => {
    await withConfig(
      { engine: 'tavily', engines: { tavily: { apiKey: ', ,' } } },
      async (handler) => {
        const { body } = await callRoute(handler, { method: 'GET', url: '/searchfuse/config' });
        const engines = body.engines as Record<
          string,
          { hasKey: boolean; keySource: string | null }
        >;
        expect(engines.tavily.hasKey).toBe(false);
        expect(engines.tavily.keySource).toBeNull();
      },
    );
  });

  it('keeps the stored key when the card submits the blank field it was shown', async () => {
    await withConfig(
      { engine: '', engines: { tavily: { apiKey: 'tvly-secret' } } },
      async (handler, file) => {
        const { status } = await callRoute(
          handler,
          postOf({ target: 'tavily', apiKey: '', baseURL: 'https://gw2.example' }),
        );
        expect(status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(saved.engines.tavily.apiKey).toBe('tvly-secret');
        expect(saved.engines.tavily.baseURL).toBe('https://gw2.example');
      },
    );
  });

  it('stores a comma-separated key list as one trimmed setting', async () => {
    await withConfig({ engine: '', engines: {} }, async (handler, file) => {
      const { status } = await callRoute(
        handler,
        postOf({ target: 'tavily', apiKey: ' first-key, second-key ' }),
      );
      expect(status).toBe(200);
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.engines.tavily.apiKey).toBe('first-key, second-key');
    });
  });

  it('stores only disabled engine overrides and removes them when re-enabled', async () => {
    await withConfig(
      {
        engine: 'tavily',
        engines: {
          tavily: { apiKey: 'tvly-secret', enabled: false },
          exa: { apiKey: 'exa-secret' },
          local: { enabled: false },
          firecrawl: { keylessFetch: false },
        },
      },
      async (handler, file) => {
        const { status } = await callRoute(
          handler,
          postOf({ enabled: { tavily: true, exa: false, local: true } }),
        );
        expect(status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(saved.engine).toBe('tavily');
        expect(saved.engines.tavily).toEqual({ apiKey: 'tvly-secret' });
        expect(saved.engines.exa).toEqual({ apiKey: 'exa-secret', enabled: false });
        expect(saved.engines.local).toBeUndefined();
        expect(saved.engines.firecrawl).toEqual({ keylessFetch: false });
      },
    );
  });

  it('leaves every setting the card does not own exactly as it was', async () => {
    // bin, allowPrivateNetwork, cooldown and keylessFetch are CLI-only on
    // purpose. A card save must be unable to touch them, including the ones
    // sitting on the very engine being edited.
    const before = {
      engine: 'tavily',
      cooldown: 'off',
      allowPrivateNetwork: true,
      engines: {
        tavily: { apiKey: 'tvly-secret', bin: '/opt/tavily' },
        'antigravity-cli': { bin: '/opt/agy' },
        firecrawl: { keylessFetch: false },
      },
    };
    await withConfig(before, async (handler, file) => {
      const { status } = await callRoute(
        handler,
        postOf({
          engine: 'exa',
          target: 'tavily',
          apiKey: '',
          baseURL: 'https://gw.example',
          bin: '/tmp/evil',
          allowPrivateNetwork: true,
          cooldown: 'off',
          keylessFetch: true,
        }),
      );
      expect(status).toBe(200);
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.cooldown).toBe('off');
      expect(saved.allowPrivateNetwork).toBe(true);
      expect(saved.engines['antigravity-cli']).toEqual({ bin: '/opt/agy' });
      expect(saved.engines.firecrawl).toEqual({ keylessFetch: false });
      expect(saved.engines.tavily).toEqual({
        apiKey: 'tvly-secret',
        bin: '/opt/tavily',
        baseURL: 'https://gw.example',
      });
      // Only the two things the card owns moved.
      expect(saved.engine).toBe('exa');
    });
  });

  it('leaves an engine the card never showed exactly as the file had it', async () => {
    // The card's chain lists only the search engines doctor found ready here,
    // so an engine this machine cannot run has no row, and neither has `local`,
    // which fetches pages rather than searching. Their stored `enabled: false`
    // must survive a save that was about something else: out of sight is not
    // the same as given up.
    const before = {
      engine: '',
      engines: {
        tavily: { apiKey: 'tvly-secret' },
        exa: { apiKey: 'exa-secret', enabled: false, baseURL: 'https://exa.example' },
        local: { enabled: false },
      },
    };
    await withConfig(before, async (handler, file) => {
      const { status } = await callRoute(handler, postOf({ enabled: { tavily: false } }));
      expect(status).toBe(200);
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.engines.exa).toEqual(before.engines.exa);
      expect(saved.engines.local).toEqual(before.engines.local);
      expect(saved.engines.tavily).toEqual({ apiKey: 'tvly-secret', enabled: false });
    });
  });

  it('keeps an unknown top-level key rather than migrating the file underneath a save', async () => {
    await withConfig(
      { engine: '', proxy: 'http://127.0.0.1:7890', engines: { agy: { bin: '/opt/agy' } } },
      async (handler, file) => {
        await callRoute(handler, postOf({ target: 'antigravity-cli', model: 'gemini-3-pro' }));
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(saved.proxy).toBe('http://127.0.0.1:7890');
        // The alias entry already holds this engine's settings, so the model
        // lands there instead of in a second entry the CLI would never read.
        expect(saved.engines.agy).toEqual({ bin: '/opt/agy', model: 'gemini-3-pro' });
        expect(saved.engines['antigravity-cli']).toBeUndefined();
      },
    );
  });

  it('writes only the engine it was given, never the one before it', async () => {
    await withConfig(
      {
        engine: 'tavily',
        engines: {
          tavily: { apiKey: 'tvly-a', baseURL: 'https://a.example' },
          exa: { apiKey: 'exa-b' },
        },
      },
      async (handler, file) => {
        await callRoute(handler, postOf({ engine: 'exa', target: 'exa', apiKey: 'exa-c' }));
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(saved.engine).toBe('exa');
        expect(saved.engines.exa).toEqual({ apiKey: 'exa-c' });
        expect(saved.engines.tavily).toEqual({
          apiKey: 'tvly-a',
          baseURL: 'https://a.example',
        });
      },
    );
  });

  it('removes a cleared endpoint override instead of writing an official default', async () => {
    await withConfig(
      {
        engine: 'tavily',
        engines: { tavily: { apiKey: 'tvly-secret', baseURL: 'https://gw.example' } },
      },
      async (handler, file) => {
        const { status } = await callRoute(
          handler,
          postOf({ target: 'tavily', apiKey: '', baseURL: '' }),
        );
        expect(status).toBe(200);
        const savedText = fs.readFileSync(file, 'utf-8');
        const saved = JSON.parse(savedText);
        expect(saved.engines.tavily).toEqual({ apiKey: 'tvly-secret' });
        expect(savedText).not.toContain('api.tavily.com');
      },
    );
  });

  it('refuses a base URL that is not http(s), the same rule the CLI applies', async () => {
    await withConfig({ engine: '', engines: {} }, async (handler, file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const { status, body } = await callRoute(
        handler,
        postOf({ target: 'tavily', baseURL: 'javascript:alert(1)' }),
      );
      expect(status).toBe(400);
      expect(String(body.error)).toContain('http');
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    });
  });

  it('refuses a key for an engine that has nowhere to put one', async () => {
    await withConfig({ engine: '', engines: {} }, async (handler, file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const { status, body } = await callRoute(
        handler,
        postOf({ target: 'grok-cli', apiKey: 'xai-secret' }),
      );
      expect(status).toBe(400);
      expect(String(body.error)).toContain('grok-cli');
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    });
  });

  it('refuses an engine name it does not know', async () => {
    await withConfig({ engine: '' }, async (handler) => {
      expect((await callRoute(handler, postOf({ engine: 'nope' }))).status).toBe(400);
      expect((await callRoute(handler, postOf({ target: 'nope' }))).status).toBe(400);
    });
  });

  // 这条曾经叫「without a plugin host/origin policy」，断言任意 Host/Origin 都放行。
  // 那正好是本次修掉的漏洞：裸 webServer 不继承 dsh 的 Connection 鉴权，浏览器里
  // 任意第三方页面都能用简单请求改 baseURL，把已存的密钥送到攻击者主机。
  // 现在反向断言：非本机来源一律 403，且磁盘上的配置不会被改动。
  it.each([
    { host: 'dsh.example.com', origin: 'https://dsh.example.com' },
    { host: '192.168.1.10:3080', origin: 'http://192.168.1.10:3080' },
    { host: '127.0.0.1:3080', origin: 'https://dsh.example.com' },
    { host: 'dsh.example.com' },
    {
      host: '127.0.0.1:3080',
      origin: 'https://dsh.example.com',
      'sec-fetch-site': 'cross-site',
    },
  ])('rejects non-loopback host or cross-site origin: %j', async (headers) => {
    await withConfig(
      { engine: 'tavily', engines: { tavily: { apiKey: 'tvly-secret' } } },
      async (handler, file) => {
        const read = await callRoute(handler, {
          method: 'GET',
          url: '/searchfuse/config',
          headers,
        });
        expect(read.status).toBe(403);

        const write = await callRoute(handler, {
          ...postOf({ engine: 'exa' }),
          headers,
        });
        expect(write.status).toBe(403);
        // 关键：被拒之后磁盘上仍是原配置，攻击者没能改掉 baseURL。
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
          engine: 'tavily',
          engines: { tavily: { apiKey: 'tvly-secret' } },
        });
      },
    );
  });

  it('rejects a POST that is not application/json (cross-site simple request)', async () => {
    await withConfig(
      { engine: 'tavily', engines: { tavily: { apiKey: 'tvly-secret' } } },
      async (handler, file) => {
        // 跨站「简单请求」只能带 text/plain 之类，浏览器不会触发预检。
        const write = await callRoute(handler, {
          method: 'POST',
          url: '/searchfuse/config',
          headers: { 'content-type': 'text/plain' },
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(JSON.stringify({ engine: 'exa' }));
          },
        });
        expect(write.status).toBe(415);
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
          engine: 'tavily',
          engines: { tavily: { apiKey: 'tvly-secret' } },
        });
      },
    );
  });

  it('reports a broken config instead of treating it as empty', async () => {
    await withConfig('{ this is not json', async (handler, file) => {
      const read = await callRoute(handler, { method: 'GET', url: '/searchfuse/config' });
      expect(read.status).toBe(409);
      expect(String(read.body.error)).toContain('JSON');
      const write = await callRoute(handler, postOf({ target: 'tavily', apiKey: 'x' }));
      expect(write.status).toBe(400);
      expect(fs.readFileSync(file, 'utf-8')).toBe('{ this is not json');
    });
  });

  it('refuses to write through a symlinked config file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modsearch-home-'));
    created.push(home);
    const real = path.join(home, 'real.json');
    const file = path.join(home, '.searchfuse', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ engine: 'tavily' }));
    fs.symlinkSync(real, file);
    const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        const plugin = (await import('../dsh/index.js')) as {
        apply: (ctx: unknown, config?: Record<string, unknown>) => void;
      };
      const stage = house();
      plugin.apply(stage.ctx as never, {});
      const { status, body } = await callRoute(
        stage.routes['modsearch-config'],
        postOf({ target: 'tavily', apiKey: 'tvly-x' }),
      );
      expect(status).toBe(400);
      expect(String(body.error)).toContain('symlink');
      expect(JSON.parse(fs.readFileSync(real, 'utf-8'))).toEqual({ engine: 'tavily' });
    } finally {
      process.env.HOME = realHome.HOME;
      process.env.USERPROFILE = realHome.USERPROFILE;
    }
  });

  it('writes with the same 0600 mode the CLI uses', async () => {
    await withConfig({ engine: '' }, async (handler, file) => {
      fs.chmodSync(file, 0o644);
      await callRoute(handler, postOf({ target: 'tavily', apiKey: 'tvly-x' }));
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    });
  });

  it('reads an environment key as present without ever echoing it', async () => {
    process.env.TAVILY_API_KEY = 'tvly-from-env';
    try {
      await withConfig({ engine: '', engines: {} }, async (handler) => {
        const { body } = await callRoute(handler, { method: 'GET', url: '/searchfuse/config' });
        expect(JSON.stringify(body)).not.toContain('tvly-from-env');
        const engines = body.engines as Record<string, { hasKey: boolean; keySource: string }>;
        expect(engines.tavily.hasKey).toBe(true);
        expect(engines.tavily.keySource).toBe('env');
      });
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('reports engine readiness from doctor, and says nothing rather than guessing', async () => {
    fakeCli(`
      if (process.argv[2] !== 'doctor' || process.argv[3] !== '--json') {
        process.exit(9);
      }
      console.log(JSON.stringify({
        roles: [
          {
            role: 'search',
            candidates: [
              { engine: 'firecrawl', ready: true, reason: 'keyless', keySource: null },
              { engine: 'tavily', ready: false, reason: 'no API key', keySource: null },
            ],
          },
          {
            role: 'social',
            candidates: [{ engine: 'grok-cli', ready: false, reason: 'binary not found' }],
          },
        ],
      }));
    `);
    await withConfig({ engine: '' }, async (handler) => {
      const { body } = await callRoute(handler, {
        method: 'GET',
        url: '/searchfuse/config?doctor=1',
      });
      const readiness = body.readiness as Array<Record<string, unknown>>;
      expect(readiness).toContainEqual(
        expect.objectContaining({ engine: 'firecrawl', ready: true }),
      );
      expect(readiness).toContainEqual(
        expect.objectContaining({ engine: 'tavily', ready: false, keySource: null }),
      );
      expect(readiness).toContainEqual(
        expect.objectContaining({ engine: 'grok-cli', ready: false }),
      );
    });

    fakeCli(`process.stderr.write('doctor exploded'); process.exit(1)`);
    await withConfig({ engine: '' }, async (handler) => {
      const { status, body } = await callRoute(handler, {
        method: 'GET',
        url: '/searchfuse/config?doctor=1',
      });
      // A failed probe must not fail the card: the readiness section simply
      // has nothing to show.
      expect(status).toBe(200);
      expect(body.readiness).toBe(null);
    });
  });

  it('forgets the cached doctor verdict once a save has rewritten the config', async () => {
    // The probe costs a process start, so its answer is cached for a minute.
    // That minute is exactly when a user saves the key that makes an engine
    // ready, and a stale verdict would tell the card the engine is still unset.
    fakeCli(`
      const fs = require('fs');
      const path = require('path');
      const counter = path.join(__dirname, 'calls');
      const calls = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf-8')) : 0) + 1;
      fs.writeFileSync(counter, String(calls));
      console.log(JSON.stringify({
        roles: [{
          role: 'search',
          candidates: [{ engine: 'tavily', ready: calls > 1, reason: 'probe ' + calls, keySource: null }],
        }],
      }));
    `);
    await withConfig({ engine: '' }, async (handler) => {
      const probe = { method: 'GET', url: '/searchfuse/config?doctor=1' };
      const first = await callRoute(handler, probe);
      expect(first.body.readiness).toContainEqual(
        expect.objectContaining({ engine: 'tavily', ready: false }),
      );
      // Second read inside the window: the same answer, without paying again.
      const cached = await callRoute(handler, probe);
      expect(cached.body.readiness).toEqual(first.body.readiness);

      await callRoute(handler, postOf({ target: 'tavily', apiKey: 'tvly-new' }));
      const after = await callRoute(handler, probe);
      expect(after.body.readiness).toContainEqual(
        expect.objectContaining({ engine: 'tavily', ready: true }),
      );
    });
  });

  it('serves the settings namespace the card is keyed by', async () => {
    await withConfig({ engine: '' }, async (_handler, _file, stage) => {
      expect(stage.namespaces).toHaveLength(1);
      expect(stage.namespaces[0].ns).toBe('modsearch');
      const schema = stage.namespaces[0].schema;
      expect(schema(undefined)).toEqual({});
      expect(schema({ kept: 1 })).toEqual({ kept: 1 });
      expect(schema.toJSON()).toEqual({
        uid: 0,
        refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
      });
      expect(stage.injected).toContainEqual(['webServer']);
      expect(stage.injected).toContainEqual(['settings']);
    });
  });

  it('serves no namespace on dsh 0.1.7, which dropped the registry, and logs nothing', async () => {
    // 0.1.7's settings service only projects volatile Config fields, and the
    // card has been keyed by package name since 0.1.6-alpha.2. Calling the
    // removed register put a TypeError in every harness log.
    const plugin = (await import('../dsh/index.js')) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stage = house({ settings: { describe: () => [], configure: () => () => {} } });
      plugin.apply(stage.ctx as never, {});
      expect(stage.injected).toContainEqual(['settings']);
      expect(stage.routes['modsearch-config']).toBeDefined();
      expect([...stage.tools.keys()].sort()).toEqual(['read_page']);
      expect(stage.providers).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps search and both tools on a host that serves no settings service', async () => {
    // The settings service is optional: a profile may leave it out, and the
    // scoped inject then never runs. Nothing else may hang on it.
    const plugin = (await import('../dsh/index.js')) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void;
    };
    const stage = house({ settings: null });
    plugin.apply(stage.ctx as never, {});
    expect(stage.injected).toContainEqual(['settings']);
    expect(stage.namespaces).toEqual([]);
    expect(stage.routes['modsearch-config']).toBeDefined();
    expect([...stage.tools.keys()].sort()).toEqual(['read_page']);
    expect(stage.providers).toHaveLength(1);
  });

  it('takes the route down with the plugin, so switching it back on serves it again', async () => {
    // The Plugins page switches a bundle off and on without restarting dsh.
    // A route left behind kept reading and writing the config file for a
    // plugin that was off, and made the next registration a duplicate.
    const plugin = (await import('../dsh/index.js')) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stage = house();
      plugin.apply(stage.ctx as never, {});
      expect(stage.routes['modsearch-config']).toBeDefined();
      stage.unload();
      expect(stage.routes['modsearch-config']).toBeUndefined();
      plugin.apply(stage.ctx as never, {});
      expect(stage.routes['modsearch-config']).toBeDefined();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('exposes the searxng section to the card without inventing defaults', async () => {
    await withConfig(
      {
        engine: '',
        searxng: {
          networks: { via_tor: { proxies: { 'all://': 'socks5h://127.0.0.1:9050' } } },
          engines: { brave: { network: 'via_tor' } },
        },
      },
      async (handler) => {
        const { body } = await callRoute(handler, { method: 'GET', url: '/searchfuse/config' });
        const searxng = body.searxng as {
          embedded: boolean;
          networks: Record<string, unknown>;
          engines: Record<string, unknown>;
        };
        // 文件里没写 embedded，而默认是开启：下发的必须是 true。
        // 旧断言写的是 false，那正是「卡片显示关闭、运行时却可用」的来源。
        expect(searxng.embedded).toBe(true);
        expect(Object.keys(searxng.networks)).toEqual(['via_tor']);
        expect(searxng.engines).toEqual({ brave: { network: 'via_tor' } });
      },
    );
  });

  it('writes a per-engine proxy with round-robin order preserved', async () => {
    await withConfig({ engine: '' }, async (handler, file) => {
      const { status } = await callRoute(
        handler,
        postOf({
          searxngEngine: 'google',
          searxngEngineProxies: { 'all://': ['http://p1:8080', 'http://p2:8080'] },
        }),
      );
      expect(status).toBe(200);
      // 数组顺序就是轮询顺序，写盘时必须原样保留；把它压成单值会让
      // 「同一协议多代理轮询」在文件里消失。
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.searxng.engines.google.proxies).toEqual({
        'all://': ['http://p1:8080', 'http://p2:8080'],
      });
    });
  });

  it('applies a batch of upstream rules without erasing unshown fields', async () => {
    // 新 UI 一次提交多个引擎的改动（而不是一次一个）。批量路径与单条路径
    // 必须共享同一份「先复制再覆盖」的保护。
    await withConfig(
      {
        engine: '',
        searxng: {
          // 网络必须真实定义，否则校验会先一步拒掉（这本身是对的）。
          networks: { via_tor: { proxies: { 'all://': 'socks5h://127.0.0.1:9050' } } },
          engines: {
            google: { network: 'via_tor', using_tor_proxy: true },
            brave: {},
          },
        },
      },
      async (handler, file) => {
        const { status } = await callRoute(
          handler,
          postOf({
            searxngRules: {
              google: { enabled: false },
              brave: { proxy: 'http://127.0.0.1:7890' },
            },
          }),
        );
        expect(status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        // google 的 network 与 tor 必须原样保留，只多一个 disabled。
        expect(saved.searxng.engines.google).toEqual({
          network: 'via_tor',
          using_tor_proxy: true,
          disabled: true,
        });
        expect(saved.searxng.engines.brave.proxies).toEqual({
          'all://': 'http://127.0.0.1:7890',
        });
      },
    );
  });

  it('writes the external SearXNG endpoint and clears it again', async () => {
    await withConfig({ engine: '' }, async (handler, file) => {
      await callRoute(
        handler,
        postOf({ searxngExternalURL: 'https://searx.example.com' }),
      );
      let saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.engines.searxng.baseURL).toBe('https://searx.example.com');

      // 空串 = 回到随包实例：地址必须被删掉，而不是写一个空值。
      await callRoute(handler, postOf({ searxngExternalURL: '' }));
      saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Object.hasOwn(saved.engines.searxng || {}, 'baseURL')).toBe(false);
    });
  });

  it('rejects an external URL that is not http(s)', async () => {
    await withConfig({ engine: '' }, async (handler, file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const { status, body } = await callRoute(
        handler,
        postOf({ searxngExternalURL: 'searx.example.com' }),
      );
      expect(status).toBe(400);
      expect(String(body.error)).toMatch(/invalid SearXNG base URL/);
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    });
  });

  it('turns the bundled instance off when an external one is chosen', async () => {
    // 三态互斥的核心契约：切到外部时，随包开关必须让位。否则两份来源同时
    // 在场，谁优先就变成实现细节而非用户的选择。
    await withConfig({ engine: '', searxng: { embedded: true } }, async (handler, file) => {
      // 卡片切到 external 时，一次提交里同时带这两项。
      await callRoute(
        handler,
        postOf({
          searxngEmbedded: false,
          searxngExternalURL: 'https://searx.example.com',
        }),
      );
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(saved.searxng.embedded).toBe(false);
      expect(saved.engines.searxng.baseURL).toBe('https://searx.example.com');

      // 再切回内置：地址必须被清掉，内置必须显式为 true。
      await callRoute(handler, postOf({ searxngEmbedded: true, searxngExternalURL: '' }));
      const back = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(back.searxng.embedded).toBe(true);
      expect(Object.hasOwn(back.engines.searxng || {}, 'baseURL')).toBe(false);
    });
  });

  it('keeps upstream rule fields the card never shows', async () => {
    // 防数据丢失红线：卡片只暴露 enabled/proxies，但配置文件里可能还有
    // network / using_tor_proxy。一次只改开关的保存绝不能把它们擦掉。
    await withConfig(
      {
        engine: '',
        searxng: {
          networks: { via_tor: { proxies: { 'all://': 'socks5h://127.0.0.1:9050' } } },
          engines: { google: { network: 'via_tor', using_tor_proxy: true } },
        },
      },
      async (handler, file) => {
        // 只提交「禁用 google」这一件事，不提 network / tor。
        const { status } = await callRoute(
          handler,
          postOf({ searxngEngine: 'google', searxngEngineDisabled: true }),
        );
        expect(status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(saved.searxng.engines.google).toEqual({
          network: 'via_tor',
          using_tor_proxy: true,
          disabled: true,
        });
      },
    );
  });

  it('keeps top-level settings the card does not render', async () => {
    // 同样的红线，换到顶层：aggregate / cooldown / hosts / serve 都不在卡片上，
    // 但保存任何一处都不能把它们抹掉。
    await withConfig(
      {
        engine: '',
        aggregate: { mode: 'chain', deadlineMs: 90000 },
        cooldown: 'off',
        allowPrivateNetwork: true,
        hosts: { omp: { enabled: false } },
        serve: { port: 7799 },
      },
      async (handler, file) => {
        const { status } = await callRoute(handler, postOf({ searxngEmbedded: true }));
        expect(status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(saved.aggregate).toEqual({ mode: 'chain', deadlineMs: 90000 });
        expect(saved.cooldown).toBe('off');
        expect(saved.allowPrivateNetwork).toBe(true);
        expect(saved.hosts).toEqual({ omp: { enabled: false } });
        expect(saved.serve).toEqual({ port: 7799 });
      },
    );
  });

  it('rejects an engine that references a network nobody defined', async () => {
    await withConfig({ engine: '' }, async (handler, file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const { status, body } = await callRoute(
        handler,
        postOf({ searxngEngine: 'brave', searxngEngineNetwork: 'via_tor' }),
      );
      expect(status).toBe(400);
      expect(String(body.error)).toMatch(/brave\.network "via_tor" is not defined/);
      // 校验失败时文件必须原样不动：一次被拒绝的保存不能留下半份配置。
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    });
  });

  it('rejects a proxy without a scheme before writing anything', async () => {
    await withConfig({ engine: '' }, async (handler, file) => {
      const before = fs.readFileSync(file, 'utf-8');
      const { status, body } = await callRoute(
        handler,
        postOf({ searxngNetwork: 'via_tor', searxngNetworkProxies: { 'all://': '127.0.0.1:7890' } }),
      );
      expect(status).toBe(400);
      expect(String(body.error)).toMatch(/include a scheme/);
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    });
  });

  it('writes an explicit false when the bundled instance is switched off', async () => {
    await withConfig({ engine: '', searxng: { embedded: true } }, async (handler, file) => {
      await callRoute(handler, postOf({ searxngEmbedded: false }));
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // 关闭写的是字面 false，而不是删掉这个键。
      //
      // src/config.ts 把「没有这个键」读作开启（`!== false`）。删键与写 false
      // 在默认值相反时才等价；这里默认是开，删键会让「关闭」变成「开启」，
      // 于是按钮点得动、文件也变了、行为却没变。
      expect(saved.searxng.embedded).toBe(false);
    });
  });

  it('reads an absent embedded key as on, matching the engine default', async () => {
    // 空白配置（文件里没有 searxng 段）下，下发给卡片的值必须是开，
    // 否则设置页与外发行为不一致。
    await withConfig({ engine: '' }, async (handler) => {
      const { body } = await callRoute(handler, { method: 'GET', url: '/searchfuse/config' });
      const searxng = body.searxng as { embedded: boolean };
      expect(searxng.embedded).toBe(true);
    });
  });

  it('registers neither the route nor the namespace when the card is switched off', async () => {
    await withConfig(
      { engine: '' },
      async (handler, _file, stage) => {
        // No route means dsh answers 404, which is how the browser half knows
        // to stand down instead of rendering a broken card.
        expect(handler).toBeUndefined();
        expect(stage.namespaces).toEqual([]);
      },
      { settingsCard: false },
    );
  });
});

describe('engine tool hot reload', () => {
  it('replaces the engine tools when the config file names a different engine', async () => {
    // Web users have no terminal, so `expose.tool` is switched from the card.
    // Without this, flipping it took a restart to show up.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withConfig(
        { engine: 'tavily', engines: { tavily: { expose: { tool: true } } } },
        async (_handler, file, stage) => {
          // 初始注册：哪台机器都还没有文件时，这里就该已经有工具了。
          expect([...stage.tools.keys()].sort()).toEqual(['read_page', 'tavily_search']);

          // 换成 exa：模拟用户从卡片上关掉 tavily、打开 exa 之后落盘的那份文件。
          fs.writeFileSync(
            file,
            JSON.stringify({ engine: 'exa', engines: { exa: { expose: { tool: true } } } }),
          );
          // 轮询靠 mtime 判断改动。Windows 的文件时间戳粒度比 POSIX 粗，
          // 写完立刻读可能拿到与上一份相同的时间，于是这次重载被跳过——
          // 测试就会在本该通过的地方失败。显式把 mtime 往前推一秒，让
          // 「文件变了」这件事不再取决于文件系统的精度的。
          const bumped = new Date(Date.now() + 2_000);
          fs.utimesSync(file, bumped, bumped);
          await vi.advanceTimersByTimeAsync(6_000);

          expect([...stage.tools.keys()].sort()).toEqual(['exa_search', 'read_page']);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the tools alone when only a key changed', async () => {
    // 换一把密钥不该让工具在屏幕上消失又出现一次：用户是看着这个列表点
    // 下去的，工具忽隐忽现等于界面上出现了一次假故障。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withConfig(
        { engine: 'tavily', engines: { tavily: { apiKey: 'first', expose: { tool: true } } } },
        async (_handler, file, stage) => {
          expect([...stage.tools.keys()].sort()).toEqual(['read_page', 'tavily_search']);
          let reRegistered = 0;
          const original = stage.tools.get('tavily_search');
          stage.tools.set = ((key: string, value: RegisteredTool) => {
            reRegistered += 1;
            return Map.prototype.set.call(stage.tools, key, value);
          }) as typeof stage.tools.set;

          fs.writeFileSync(
            file,
            JSON.stringify({
              engine: 'tavily',
              engines: { tavily: { apiKey: 'second', expose: { tool: true } } },
            }),
          );
          // 与上一条同理：mtime 要显式往前推，否则 Windows 上可能读到同一个
          // 时间戳，轮询什么都不做，而这条测试要验的正是「被通知了但没重建」。
          const bumped = new Date(Date.now() + 2_000);
          fs.utimesSync(file, bumped, bumped);
          await vi.advanceTimersByTimeAsync(6_000);

          expect(reRegistered).toBe(0);
          expect(stage.tools.get('tavily_search')).toBe(original);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dsh plugin config switches', () => {
  it('registers nothing when every surface is switched off', async () => {
    const { tools, providers } = await load({
      searchProvider: false,
      xSearch: false,
      readPage: false,
    });
    expect(tools.size).toBe(0);
    expect(providers).toHaveLength(0);
  });

  it('stays a tools-only plugin when the web seam surface moved', async () => {
    const plugin = (await import('../dsh/index.js')) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void;
    };
    const tools = new Map<string, RegisteredTool>();
    plugin.apply(
      {
        tools: {
          register: (definition: RegisteredTool) => {
            tools.set(definition.name, definition);
          },
        },
        web: {},
      } as never,
      {},
    );
    expect([...tools.keys()].sort()).toEqual(['read_page']);
  });

  it('keeps search, x_search and read_page on a host with no scoped injects at all', async () => {
    // Headless profiles have neither webServer nor settings, and older hosts
    // have no ctx.inject to hang them on. The settings card is the only thing
    // that may go missing there.
    const { tools, providers } = await load();
    expect([...tools.keys()].sort()).toEqual(['read_page']);
    expect(providers).toHaveLength(1);
  });
});
