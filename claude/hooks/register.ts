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
}

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

/** `on(event, matcher, handler)` 的最小形状。 */
type HostOn = (
  event: string,
  matcher: Record<string, unknown>,
  handler: ($: HostDollar, e: ToolCallEvent, next: HostNext) => Promise<unknown>,
) => Registration;

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

export function register(on: HostOn, _options: unknown): void {
  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    if (!(await isHostEnabled($, next))) {
      return next(e);
    }

    let run: { exitCode: number; stdout: string };
    try {
      run = await $.process.run({
        // `process` 走 globalThis：宿主 `types: []`，直接写 `process` 会 TS2591。
        argv: [
          // 经 `unknown` 再断言：host 的 `types: []` 没有 Node 类型，直接写
          // `process` 会 TS2591；而 `typeof globalThis` 与目标形状不重叠。
          (globalThis as unknown as { process: { execPath: string } }).process.execPath,
          KERNEL_PATH,
          '--query',
          e.query ?? '',
          '--source',
          'web',
        ],
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: next.signal,
      });
    } catch {
      // 起不来或超时：交回宿主。
      return next(e);
    }

    if (run.exitCode !== 0) {
      // 没有结果不是错误——宿主原生实现可能找得到。
      return next(e);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      return next(e);
    }

    const result = toNativeShape(parsed, e.query ?? '', e.tool_use_id ?? 'searchfuse');
    if (!result) {
      return next(e);
    }
    return { result };
  })
    // 钩子抛错或超时会被宿主跳过，于是原生搜索照常跑。这个 catch 只是
    // 让回退语义显式，而不是依赖宿主的隐式跳过。
    .catch((_$, e, next) => next(e));
}
