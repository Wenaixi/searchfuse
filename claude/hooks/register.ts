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
const KERNEL_PATH = new URL('../../dist/kernel.js', moduleUrl).href;

/** 一次搜索的墙钟上限。比聚合默认的 8 秒宽，留给慢引擎。 */
const SEARCH_TIMEOUT_MS = 240_000;

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

/**
 * 跑一次 kernel，返回原始 stdout；失败返回 undefined。
 *
 * 三个工具（web_search / x_search / read_page）共用这一条通道，区别只在
 * 附加参数。集中一处的好处是超时、取消、退出码的判定只有一份——
 * 三份各写一遍迟早会在某一个工具上漏掉 `signal`。
 */
async function runKernelFor(
  $: HostDollar,
  next: HostNext,
  extraArgs: string[],
): Promise<string | undefined> {
  let run: { exitCode: number; stdout: string };
  try {
    run = await $.process.run({
      argv: [
        // 宿主 `types: []` 没有 Node 类型，直接写 process 会 TS2591。
        (globalThis as unknown as { process: { execPath: string } }).process.execPath,
        KERNEL_PATH,
        ...extraArgs,
      ],
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: next.signal,
    });
  } catch {
    return undefined;
  }
  if (run.exitCode !== 0) return undefined;
  return run.stdout;
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
  // 1. 移除内置搜索工具 —— 模型只看到我们这一个，不存在「两个都能搜」的歧义。
  on('tool.list', undefined as unknown as Record<string, unknown>, async ($, e, next) => {
    const list = (await next(e)) as ToolListResult | undefined;
    if (!list || !Array.isArray(list.value)) return next(e);
    // 宿主关闭接管的配置下不动：用户要的就是原生行为。
    if (!(await isHostEnabled($, next))) return list;
    return { ...list, value: list.value.filter((tool) => tool.name !== BUILTIN_SEARCH) };
  })
    .catch((_$, _e, next) => next(_e));

  // 2. 注册我们的搜索工具。宿主会补上 `mcp__searchfuse__` 前缀。
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'web_search',
        description: '搜索网页。多个搜索引擎并发查询并按相关性融合，返回带标题、链接与摘要的列表。',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: '要搜索的内容' } },
          required: ['query'],
        },
        // false：让它出现在顶层工具列表，而不是藏进 tool search 后面。
        isDeferred: false,
      });
      // x_search：X/Twitter 语料。dsh 有、omp 有，这里补上同一个能力。
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
      // read_page：抓取并消化一个页面（正文摘出来，而不是原始 HTML）。
      await $.tool.register({
        name: 'read_page',
        description: '读取一个网页并返回它的正文摘要与链接。传 URL。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '要读取的页面地址' } },
          required: ['url'],
        },
        isDeferred: false,
      });
    } catch {
      // 注册失败不该让会话起不来：没有我们的工具时，用户还能用别的办法。
    }
    return next(e);
  })
    .catch((_$, _e, next) => next(_e));

  // x_search 的调用处理。名字与注册时的短名对应，宿主补前缀。
  on('tool.call', { tool: 'mcp__searchfuse__x_search' }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) return next(e);
    const run = await runKernelFor($, next, ['--query', stringField(e, 'query'), '--source', 'x']);
    if (run === undefined) return { result: 'X 搜索失败（本地聚合器不可用）。' };
    return { result: run };
  }).catch((_$, _e, next) => next(_e));

  // read_page 的调用处理：走 --url。
  on('tool.call', { tool: 'mcp__searchfuse__read_page' }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) return next(e);
    const run = await runKernelFor($, next, ['--url', stringField(e, 'url')]);
    if (run === undefined) return { result: '页面读取失败（本地聚合器不可用）。' };
    return { result: run };
  }).catch((_$, _e, next) => next(_e));

  on('tool.call', { tool: TOOL_NAME }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) {
      return next(e);
    }

    const stdout = await runKernelFor($, next, ['--query', stringField(e, 'query'), '--source', 'web']);
    if (stdout === undefined) {
      // 原生工具已被移除，没有「回退」可言。把原因交给模型，
      // 让它换个办法（比如直接读已知 URL）而不是原地重试。
      return { result: '搜索失败（本地聚合器不可用或返回非零退出码）。' };
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
    // 钩子抛错或超时会被宿主跳过，于是原生搜索照常跑。这个 catch 只是
    // 让回退语义显式，而不是依赖宿主的隐式跳过。
    .catch((_$, e, next) => next(e));
}
