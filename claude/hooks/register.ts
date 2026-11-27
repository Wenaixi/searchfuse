// Claude Code Mod 的唯一手写代码。
//
// 职责：把宿主的 `WebSearch` 调用接管过来，用 searchfuse 的聚合结果回答；
// 任何一步失败就交回宿主原生实现（`next(e)`），绝不让用户因为插件坏了而
// 失去搜索能力。
//
// 为什么 spawn 子进程而不是自己实现聚合：聚合逻辑只存在于 `src/search.ts`，
// 编译成 `dist/kernel.js`。这里只负责「问一句、拿结果、翻译成宿主形状」。
//
// 宿主的硬约束（全部实测确认，违反会被 `claude plugin validate` 拒绝）：
//
// - `$` 只能在 hook 体内部以 `$.noun.method(...)` 出现，不能当参数传给自由函数
// - 辅助函数必须在文件顶层声明（函数声明或 const 绑定）
// - 不能 import 任何非相对路径、非 `claude-code` 的模块——所以在本地声明
//   用到的形状，而不是从宿主导入类型（那个模块在安装包里不存在）
// - 参数必须显式标注类型，否则 `TS7006`

/**
 * 宿主的 tsconfig 不含 ESNext lib，`import.meta.url` 报 TS2339。运行时它
 * 是存在的（hooks 模块以 ES module 加载），所以本地声明形状而不是换写法。
 */
const moduleUrl = (import.meta as unknown as { url: string }).url;

/** kernel 的绝对路径。插件根在 `hooks/` 的上一级，产物在同级 `dist/`。 */
/** kernel 的绝对路径同样来自 settings（见 runtimePathFromSettings）。 */

/** 一次搜索的墙钟上限。比聚合默认的 8 秒宽，留给慢引擎。 */
const SEARCH_TIMEOUT_MS = 240_000;
/** 唤醒服务的上限。与 omp 扩展侧的 WAKE_TIMEOUT_MS 保持一致。 */
const WAKE_TIMEOUT_MS = 15_000;

/**
 * 宿主在 hook 里注入的 `$` 的**最小形状**：只声明这个 hook 真正调用的方法。
 *
 * 宿主不在安装包里提供类型声明（实测：全局安装只有 `sdk-tools.d.ts`，
 * 没有 `.claude-plugin/types/`），所以在本地声明。只写用到的部分，多写一个
 * 就等于替宿主承诺了一件没验证过的事。
 */
interface HostDollar {
  settings: {
    read(args: { key: string; signal?: unknown }): Promise<unknown>;
  };
  process: {
    run(args: {
      argv: string[];
      timeoutMs?: number;
      signal?: unknown;
    }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  fs: {
    read(path: string): Promise<string>;
  };
  http: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<{ status: number; ok: boolean; text: string; headers?: Record<string, string> }>;
  };
  tool: {
    /**
     * 注册一个工具。宿主会强制全名为 `mcp__<plugin>__<name>`（实测），
     * 所以传 `web_search` 得到的是 `mcp__searchfuse__web_search`。
     */
    register(spec: {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      isDeferred?: boolean;
    }): Promise<unknown>;
  };
}

/** 我们的工具在宿主里的全名。 */
const TOOL_NAME = 'mcp__searchfuse__web_search';

/** 被移除的内置工具名。 */
const BUILTIN_SEARCH = 'WebSearch';

/** 事件载荷：`tool.call` 上 `e` 的字段直接摊在顶层（实测确认）。 */
interface ToolCallEvent {
  tool: string;
  query?: string;
  tool_use_id?: string;
}

/** 下一个 handler。`signal` 是事件被放弃时的中止信号。 */
interface HostNext {
  (event: unknown): unknown;
  signal?: unknown;
}

/** `on(...)` 的返回值：只有一个 `.catch`。 */
interface Registration {
  catch(handler: ($: HostDollar, e: ToolCallEvent, next: HostNext) => unknown): void;
}

/** 事件载荷：除了 tool.call，其它事件我们只关心 `value` 之类的通用字段。 */
type AnyEvent = Record<string, unknown>;

/**
 * `on(...)` 的最小形状。
 *
 * 宿主的 matcher 是可选的（`on('tool.call', { tool }, hook)` 与
 * `on('session.start', hook)` 都合法），所以这里给出重载形态而不是一个
 * 接受 `undefined` 的宽松签名——后者会让调用点看不出「哪个事件带 matcher」。
 */
interface HostOn {
  (event: string, matcher: Record<string, unknown>, handler: HandlerOf): Registration;
  (event: string, handler: HandlerOf): Registration;
}

/** 一个 hook 的形状。`e` 因事件而异，用宽类型让它能被每个调用点收窄。 */
type HandlerOf = ($: HostDollar, e: AnyEvent, next: HostNext) => Promise<unknown>;

/** 宿主原生 `WebSearchOutput` 的一条命中。 */
interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/** 翻译后的原生结果。字段与 `sdk-tools.d.ts` 的 `WebSearchOutput` 对齐。 */
interface NativeSearchOutput {
  query: string;
  results: Array<{ tool_use_id: string; content: SearchHit[] }>;
  durationSeconds: number;
}

/** `~/.searchfuse/runtime.json` 里我们关心的两字段。 */
interface ServeRuntime {
  port: number;
  token: string;
}

/** 缓存：服务重启换端口时靠「连接失败后重读」兜底，所以缓存可以放心用。 */
let cachedRuntime: ServeRuntime | undefined;
/** 缓存对应的 `runtime.json` 内容摘要，变了就重读。 */
let cachedStamp = '';

/**
 * 读 `~/.searchfuse/runtime.json`，拿到服务的端口与 token。
 *
 * 为什么走 `$.fs.read` 而不是 `$` 的其它通道：宿主的 hooks 沙箱**没有
 * `process`**（实测 `globalThis.process` 是 undefined），所以既不能 spawn
 * 也不能读环境变量里的 home；`$.fs.read` 是唯一能读绝对路径的入口。
 *
 * 缓存策略：文件不大，但每次搜索都读一次纯属浪费。用「文件内容变化就重读」
 * 判断——比 mtime 简单，且 runtime.json 只在服务起停时变。
 */
/**
 * 找到 `runtime.json` 的绝对路径与身份信息。
 *
 * 为什么需要这一步：宿主的 mod 沙箱里 **`~` 不展开**，`$.env.get('HOME')`
 * 也返回 undefined（实测），所以拿不到家目录。唯一可行的办法是让
 * `searchfuse hosts sync` 把绝对路径写进 Claude 的 settings，mod 通过
 * `$.settings.read` 读回来——那条通道是宿主明确支持的。
 *
 * 同时把 fingerprint 与候选端口带回来：runtime.json 会在服务被 kill 时
 * 消失（close 跑不到），那时只能靠这些候选端口逐个探 `/identity` 并把
 * 应答者自称的指纹与本机算好的比对。沙箱里没有 crypto，算不了指纹，
 * 所以由 CLI 侧预先写好。
 *
 * 读不到就返回 undefined：调用方据此回退到 `$.process.run` 直接跑 kernel。
 */
async function hostInfoFromSettings(
  $: HostDollar,
  next: HostNext,
): Promise<{ runtimePath?: string; fingerprint?: string; ports?: number[] } | undefined> {
  try {
    const value = await $.settings.read({ key: 'searchfuseHosts', signal: next.signal });
    const hosts = asRecord(value);
    const claude = asRecord(hosts?.claudeCode);
    if (claude === undefined) return undefined;
    const path = claude.runtimePath;
    const fingerprint = claude.fingerprint;
    const ports = claude.ports;
    return {
      runtimePath: typeof path === 'string' && path !== '' ? path : undefined,
      fingerprint: typeof fingerprint === 'string' && fingerprint !== '' ? fingerprint : undefined,
      ports: Array.isArray(ports) ? ports.filter((p): p is number => typeof p === 'number' && Number.isInteger(p)) : undefined,
    };
  } catch {
    return undefined;
  }
}

async function runtimePathFromSettings($: HostDollar, next: HostNext): Promise<string | undefined> {
  return (await hostInfoFromSettings($, next))?.runtimePath;
}

async function readServeRuntime(
  $: HostDollar,
  next: HostNext,
): Promise<ServeRuntime | undefined> {
  const info = await hostInfoFromSettings($, next);
  if (info?.runtimePath !== undefined) {
    try {
      const raw = await $.fs.read(info.runtimePath);
      if (raw === cachedStamp && cachedRuntime !== undefined) return cachedRuntime;
      const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
      if (typeof parsed.port === 'number' && typeof parsed.token === 'string') {
        cachedRuntime = { port: parsed.port, token: parsed.token };
        cachedStamp = raw;
        return cachedRuntime;
      }
    } catch {
      // 文件不在或读不了：往下走候选探测。
      cachedRuntime = undefined;
      cachedStamp = '';
    }
  }

  // runtime.json 不在（服务被 kill 时 close 跑不到，文件会消失）。
  // 按 CLI 预先写进 settings 的候选端口逐个探 /identity，指纹匹配才算。
  // 只探 200 会把恰好占着那个端口的别的程序认成自己的服务，然后把 token
  // 发给它。
  if (info?.fingerprint === undefined || info.ports === undefined || info.ports.length === 0) {
    return undefined;
  }
  // token 文件与 runtime.json 同目录：`runtime.json` → `serve-token`。
  // 沙箱里读不了家目录，但这条路径由 runtimePath 直接推出，不需要 HOME。
  const tokenPath = info.runtimePath === undefined ? undefined : serveTokenPathFrom(info.runtimePath);
  if (tokenPath === undefined) return undefined;
  for (const port of info.ports) {
    try {
      const body = await $.http.fetch(`http://127.0.0.1:${port}/identity`, {
        headers: { accept: 'application/json' },
      });
      if (!body.ok) continue;
      const parsed = JSON.parse(body.text) as { fingerprint?: unknown };
      if (parsed.fingerprint !== info.fingerprint) continue;
      // 指纹对上了：端口是这一份的服务，token 从同目录的 token 文件读。
      const token = (await $.fs.read(tokenPath)).trim();
      if (token !== '') {
        cachedRuntime = { port, token };
        cachedStamp = '';
        return cachedRuntime;
      }
    } catch {
      // 该端口不通或不是 JSON：换下一个。
    }
  }
  return undefined;
}

/**
 * 从 runtime.json 的绝对路径推出 serve-token 的绝对路径。
 *
 * 两者永远同目录（都由 `serve.ts` 的 `runtimePath()` / `serveTokenPath()` 拼出），
 * 所以这里只做一次字符串替换，不必再往 settings 里多写一条路径。
 */
function serveTokenPathFrom(runtimePath: string): string | undefined {
  const index = runtimePath.lastIndexOf('runtime.json');
  if (index === -1) return undefined;
  return `${runtimePath.slice(0, index)}serve-token`;
}

/**
 * 通过 HTTP 调本地服务。失败返回 undefined，调用方据此回退。
 *
 * 为什么是 HTTP 而不是 spawn 子进程：宿主的 hooks 沙箱没有 `process`，
 * 起不了子进程。而服务本身就是同一个聚合器，走 HTTP 拿到的是同一份结果。
 */
async function callServe(
  $: HostDollar,
  next: HostNext,
  endpoint: string,
  params: Record<string, string>,
): Promise<string | undefined> {
  // 第一次读（可能需要，也可能命中缓存）。
  let runtime = await readServeRuntime($, next);
  if (runtime === undefined) return undefined;

  const buildUrl = (r: ServeRuntime): string => {
    const search = new URLSearchParams(params);
    return `http://127.0.0.1:${r.port}${endpoint}?${search.toString()}`;
  };

  const attempt = async (r: ServeRuntime): Promise<{ ok: true; text: string } | { ok: false; retry: boolean }> => {
    try {
      const response = await $.http.fetch(buildUrl(r), {
        headers: { authorization: `Bearer ${r.token}`, accept: 'application/json' },
      });
      if (response.ok) return { ok: true, text: response.text };
      // 401 意味着 token 过期（服务重启换过 token）：重读一次再试。
      return { ok: false, retry: response.status === 401 };
    } catch {
      // 连接被拒：服务可能换端口了，重读 runtime.json 再试一次。
      return { ok: false, retry: true };
    }
  };

  const first = await attempt(runtime);
  if (first.ok) return first.text;

  if (!first.retry) return undefined;

  // 重读并重试一次。
  cachedStamp = '';
  runtime = await readServeRuntime($, next);
  if (runtime === undefined) return undefined;
  const second = await attempt(runtime);
  return second.ok ? second.text : undefined;
}

/**
 * 取一次搜索结果：**服务优先，子进程兜底，最后拉起服务再试一次**。
 *
 * 三条路：
 * 1. 本地服务在跑 → `$.http.fetch` 打 `/v1/search`（快，省一次进程启动）
 * 2. 服务不在 → `$.process.run(['node', kernel.js])` 直接跑聚合器
 * 3. 两条都失败 → 跑一次 `serve --ensure` 把服务拉起来，再走一次第 1 条
 *
 * 为什么两条都要：服务是可选加速器，不是必需品。只走 HTTP 的话，用户没起
 * 服务就等于没搜索；只走子进程的话，每次搜索都多一次 Node 启动（约 200ms）。
 *
 * 为什么第三级放在这里而不是每条路径内部：这两条路都失败，说明这次搜索本来
 * 就要失败了，此刻多付一次 `serve --ensure` 的成本可以接受；若放在每条路径
 * 内部，每次 tool.call 都会多 spawn 一个进程探一次，代价完全不同。
 *
 * 为什么 `$.process.run` 用裸名 `'node'`：mod 沙箱里没有 `globalThis.process`
 * （实测 undefined），拿不到 `process.execPath`。宿主会按 PATH 解析裸名。
 *
 * 失败返回 undefined，调用方据此回退。
 */
async function fetchOrSpawn(
  $: HostDollar,
  next: HostNext,
  target: { endpoint: string; params: Record<string, string>; kernelArgs: string[] },
): Promise<string | undefined> {
  // 路径一：HTTP。
  const runtime = await readServeRuntime($, next);
  if (runtime !== undefined) {
    const text = await callServe($, next, target.endpoint, target.params);
    if (text !== undefined) return text;
  }

  // 路径二：子进程。kernel 的绝对路径同样来自 settings。
  const kernelPath = await kernelPathFromSettings($, next);
  if (kernelPath === undefined) return undefined;
  const spawned = await runKernel($, next, kernelPath, target.kernelArgs);
  if (spawned !== undefined) return spawned;

  // 路径三：把服务拉起来，再试一次 HTTP。子进程能跑通说明 kernel 存在，
  // 所以这次拉起用的 CLI 也一定在同一个 dist 目录里。
  if (!(await wakeServe($, next, kernelPath))) return undefined;
  return await callServe($, next, target.endpoint, target.params);
}

/** 跑一次 kernel 子进程；失败返回 undefined。 */
async function runKernel(
  $: HostDollar,
  next: HostNext,
  kernelPath: string,
  kernelArgs: string[],
): Promise<string | undefined> {
  try {
    const run = await $.process.run({
      argv: ['node', kernelPath, ...kernelArgs],
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: next.signal,
    });
    if (run.exitCode !== 0) return undefined;
    return run.stdout;
  } catch {
    return undefined;
  }
}

/**
 * 拉起本地服务。
 *
 * **不能用退出码判成功。** 实测：`serve --ensure` 在「已经在跑」时立刻
 * exit 0，而在真正需要起服务时会把服务拉起来并**常驻不退出**。沙箱的
 * `$.process.run` 会一直等到 `timeoutMs` 到点才返回，那时服务已经起来了，
 * 但退出码通常不是 0——按退出码判就会把成功报成失败，白等一整个超时。
 *
 * 所以先探一次：服务已经在跑就直接返回 true，一次子进程都不起。真的需要
 * 拉起时才调 `serve --ensure`，拉起之后**再探一次**，以健康检查为准。
 *
 * CLI 入口从 kernel 的绝对路径推——两个产物永远在同一个 dist 目录，而
 * settings 里只写了 kernelPath 这一个绝对路径，各推一次就会漂移。
 *
 * 沙箱里没有 `process`，所以与已有的子进程兜底用同一套：`$.process.run`
 * 加裸名 `'node'`。
 */
async function wakeServe($: HostDollar, next: HostNext, kernelPath: string): Promise<boolean> {
  // 已经在跑：什么都不做，直接告诉调用方可以重试 HTTP。
  if (await healthOnce($, next)) return true;

  const cliPath = kernelPath.replace(/kernel\.js$/, 'main.js');
  // 路径里没有 kernel.js 说明 settings 里写的不是我们以为的那个文件，
  // 这时不猜，直接放弃。
  if (cliPath === kernelPath) return false;
  try {
    await $.process.run({
      argv: ['node', cliPath, 'serve', '--ensure'],
      timeoutMs: WAKE_TIMEOUT_MS,
      signal: next.signal,
    });
  } catch {
    // 超时或失败都可能发生在服务已经起来之后，所以这里不判死，
    // 交给下面的健康检查说最后一句。
  }
  return await healthOnce($, next);
}

/** 探一次本地服务的 `/healthz`。读不到 runtime.json 就是没起。 */
async function healthOnce($: HostDollar, next: HostNext): Promise<boolean> {
  const runtime = await readServeRuntime($, next);
  if (runtime === undefined) return false;
  try {
    const response = await $.http.fetch(`http://127.0.0.1:${runtime.port}/healthz`, {
      method: 'GET',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** kernel 的绝对路径，也由 `hosts sync` 写进 settings。 */
async function kernelPathFromSettings($: HostDollar, next: HostNext): Promise<string | undefined> {
  try {
    const value = await $.settings.read({ key: 'searchfuseHosts', signal: next.signal });
    const hosts = asRecord(value);
    const claude = asRecord(hosts?.claudeCode);
    const path = claude?.kernelPath;
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
}

/** 从事件里安全取一个字符串字段；不是字符串时返回空串。 */
function stringField(event: AnyEvent, field: string): string {
  const value = event[field];
  return typeof value === 'string' ? value : '';
}

/** 只读的 JSON 访问：把 `unknown` 收窄成一个可安全点读的记录。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 从一条聚合条目里取一条命中；缺 `url` 的条目直接丢弃（宿主需要它）。 */
function toHit(value: unknown): SearchHit | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const url = typeof record.url === 'string' ? record.url : undefined;
  if (!url) return undefined;
  const title = typeof record.title === 'string' ? record.title : url;
  const snippet =
    typeof record.snippet === 'string'
      ? record.snippet
      : typeof record.summary === 'string'
        ? record.summary
        : undefined;
  return snippet === undefined ? { title, url } : { title, url, snippet };
}

/**
 * 把 `RunSearchResult` 翻译成宿主 `WebSearchOutput` 的形状。
 *
 * `tool_use_id` 必须取自事件本身（`e.tool_use_id`），不能伪造——宿主用它
 * 把结果块与工具调用配对。
 */
function toNativeShape(raw: unknown, query: string, toolUseId: string): NativeSearchOutput | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;

  const results = Array.isArray(root.results) ? root.results : [];
  const firstEntry = asRecord(results[0]);
  if (!firstEntry) return undefined;

  const items = Array.isArray(firstEntry.items) ? firstEntry.items : [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    const hit = toHit(item);
    if (hit) hits.push(hit);
  }
  if (hits.length === 0) return undefined;

  const entrySeconds =
    typeof firstEntry.durationSeconds === 'number' ? firstEntry.durationSeconds : undefined;
  const meta = asRecord(root.meta);
  const metaSeconds = typeof meta?.durationSeconds === 'number' ? meta.durationSeconds : undefined;

  return {
    query,
    results: [{ tool_use_id: toolUseId, content: hits }],
    durationSeconds: entrySeconds ?? metaSeconds ?? 0,
  };
}

/**
 * 读共享配置里的宿主开关。
 *
 * 读不到就当作「开启」：用户装这个插件就是为了接管搜索，一个读配置失败
 * 不该让功能整体失效。要关掉它必须显式写 `false`。
 */
async function isHostEnabled($: HostDollar, next: HostNext): Promise<boolean> {
  try {
    const value = await $.settings.read({ key: 'searchfuseHosts', signal: next.signal });
    const hosts = asRecord(value);
    const claude = asRecord(hosts?.claudeCode);
    return claude?.enabled !== false;
  } catch {
    return true;
  }
}

/** `tool.list` 的返回形状：`next(e)` 给的是 `{ value: [{ name, description, ... }] }`（实测）。 */
interface ToolListResult {
  value: Array<{ name: string; [field: string]: unknown }>;
}

export function register(on: HostOn, _options: unknown): void {
  // ── 替换原生搜索：同名覆盖 ──────────────────────────────────────────
  //
  // 工具**仍然叫 `WebSearch`**，模型看到的就是它；我们的 hook 在同一名字上
  // 回答，宿主的原生实现不再运行。这是「替换」，不是「加一个并列工具」——
  // 后者会让模型在两个搜索之间犹豫。
  //
  // `tool.call` 在权限检查之前触发，返回 `{ result }` 即短路整条链路；
  // 失败时 `next(e)` 交回原生，这是唯一的安全网（原生实现仍在，只是没被
  // 走到）。
  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) {
      return next(e);
    }

    const query = stringField(e, 'query');
    const stdout = await fetchOrSpawn($, next, {
      endpoint: '/v1/search',
      params: { q: query, source: 'web' },
      kernelArgs: ['--query', query, '--source', 'web'],
    });
    if (stdout === undefined) {
      // 我们答不上来：交回宿主原生实现。这是替换方案里唯一的回退，
      // 也是它比「移除原生」更稳的原因。
      return next(e);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return next(e);
    }

    const result = toNativeShape(parsed, stringField(e, 'query'), stringField(e, 'tool_use_id') || 'searchfuse');
    if (!result) {
      return next(e);
    }
    return { result };
  })
    .catch((_$, e, next) => next(e));

  // ── 额外能力：x_search / read_page ────────────────────────────────
  //
  // 这两个宿主原生没有，所以注册成新工具（宿主会补 `mcp__searchfuse__` 前缀）。
  // 名字与 dsh / omp 侧保持一致：`x_search`、`read_page`。
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'x_search',
        description: '搜索 X（Twitter）上的帖子。与网页搜索分开走语料链路，返回帖子与其上下文。',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: '要搜索的内容' } },
          required: ['query'],
        },
        isDeferred: false,
      });
      await $.tool.register({
        name: 'read_page',
        description: '读取一个网页并返回它的正文摘要与链接。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '要读取的页面地址' } },
          required: ['url'],
        },
        isDeferred: false,
      });
    } catch {
      // 注册失败不该让会话起不来。
    }
    return next(e);
  })
    .catch((_$, _e, next) => next(_e));

  on('tool.call', { tool: 'mcp__searchfuse__x_search' }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) return next(e);
    const query = stringField(e, 'query');
    const stdout = await fetchOrSpawn($, next, {
      endpoint: '/v1/search',
      params: { q: query, source: 'x' },
      kernelArgs: ['--query', query, '--source', 'x'],
    });
    if (stdout === undefined) return { result: 'X 搜索失败（本地聚合器不可用）。' };
    return { result: stdout };
  }).catch((_$, _e, next) => next(_e));

  on('tool.call', { tool: 'mcp__searchfuse__read_page' }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) return next(e);
    const url = stringField(e, 'url');
    const stdout = await fetchOrSpawn($, next, {
      endpoint: '/v1/read-page',
      params: { url },
      kernelArgs: ['--url', url],
    });
    if (stdout === undefined) return { result: '页面读取失败（本地聚合器不可用）。' };
    return { result: stdout };
  }).catch((_$, _e, next) => next(_e));
}
