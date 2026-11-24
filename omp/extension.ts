// omp 扩展：用同名 `web_search` 覆盖内置的搜索工具。
//
// 为什么是同名覆盖而不是「禁用内置 + 换个名字」：实测确认扩展注册同名
// 工具会覆盖内置的那个（源码 `sdk.ts` 的 `toolRegistry.set(name, liveTool)`
// + `setToolBuiltIn(name, false)`），模型只看到我们这一个。换名字会让
// 模型在两个搜索工具之间犹豫。
//
// 注意这是 omp 的扩展 API，不是 Claude Code 的 `$` DSL——两者完全不同：
// omp 是 `pi.on(...)` / `pi.registerTool(...)`，参数用 `pi.zod`，
// 事件名带下划线（`session_start`）。
//
// 由 `searchfuse hosts sync` 渲染后写到 ~/.omp/agent/extensions/：
//   __SEARCHFUSE_KERNEL_PATH__  → dist/kernel.js 的绝对路径
// 渲染而不是裸复制，因为复制之后扩展与包的 dist/ 已无相对关系。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';

/** 渲染时替换成真实的绝对路径。 */
const KERNEL_PATH = '__SEARCHFUSE_KERNEL_PATH__';

/** 一次搜索的墙钟上限。比聚合默认的 8 秒宽，留给慢引擎。 */
/** 唤醒服务允许的最长等待（它通常几百毫秒就起来）。 */
const WAKE_TIMEOUT_MS = 15_000;

/** 服务端点请求本身的超时上限，比唤醒宽松（它可能要真的跑一次搜索）。 */
const SEARCH_TIMEOUT_MS = 240_000;

/**
 * 找一个真正的 Node 可执行文件来跑 kernel。
 *
 * **不能用 `process.execPath`**：omp 是 Bun 编译的单文件二进制，实测
 * `process.execPath` 指向 `omp.exe` 本身。用它去跑 `kernel.js` 等于
 * 「让 omp 去执行一个 .js」，它把 `--query` 当作自己的参数，直接 exit 2。
 *
 * 优先级：`SEARCHFUSE_NODE` 环境变量（给非常规安装）→ `Bun.which('node')`
 * → 裸 `node`（交给 PATH 解析）。都不是就返回 undefined，调用方报错。
 */
function resolveNodeBinary(): string | undefined {
  const fromEnv = process.env.SEARCHFUSE_NODE;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  // omp 运行时是 Bun，`Bun.which` 按 PATH 解析可执行文件。
  const bun = (globalThis as { Bun?: { which?: (name: string) => string | null } }).Bun;
  const found = bun?.which?.('node');
  if (typeof found === 'string' && found !== '') return found;
  // 交给 spawn 自己按 PATH 找。
  return 'node';
}

/** kernel 输出的结果条目形状（我们只关心展示要用的那几个字段）。 */
interface KernelHit {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
}

/** 跑一次 kernel，拿回结构化结果。失败返回 undefined，由调用方回退。 */
/**
 * 跑一次 kernel。`args` 是附加参数（`--query ...` / `--url ...` 等）。
 *
 * 三个工具共用这一条通道：超时、取消、退出码的判定只写一份。
 */
/** `~/.searchfuse/runtime.json` 的形状；读不到就是服务没起。 */
interface ServeRuntime {
  port: number;
  token: string;
}

/**
 * 读服务的运行时信息。
 *
 * omp 扩展是普通 Node 进程（不是 mod 沙箱），所以能直接用 fs 与 homedir。
 */
function readServeRuntime(): ServeRuntime | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.searchfuse', 'runtime.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return undefined;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return undefined;
  }
}

/**
 * 把 kernel 的 argv 翻译成服务的查询参数。
 *
 * 三个工具的参数不同（`--query` vs `--url`），但服务端点也是分开的，
 * 所以这里只负责挑出「用哪个端点、带哪些查询串」。
 */
function toServeRequest(args: string[]): { endpoint: string; params: Record<string, string> } | undefined {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const url = flag('--url');
  if (url !== undefined) {
    return { endpoint: '/v1/read-page', params: { url } };
  }
  const query = flag('--query');
  if (query === undefined) return undefined;
  const params: Record<string, string> = { q: query, source: flag('--source') ?? 'web' };
  const max = flag('--max-results');
  if (max !== undefined) params.max = max;
  return { endpoint: '/v1/search', params };
}

/**
 * 取一次搜索结果：**服务优先，子进程兜底**。
 *
 * omp 侧有完整 Node，两条路都能走；服务在跑时省掉一次进程启动。
 */
/** 调一次服务；拿到文本就返回，否则 undefined。 */
async function tryServe(args: string[], signal: AbortSignal | undefined): Promise<string | undefined> {
  const runtime = readServeRuntime();
  if (runtime === undefined) return undefined;
  const request = toServeRequest(args);
  if (request === undefined) return undefined;
  const search = new URLSearchParams(request.params);
  // 服务端跑一次聚合可能要几十秒，所以给足时间；但必须有一个上限，
  // 否则服务卡住时这次工具调用会永久挂起，连取消都只能靠宿主的信号。
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${request.endpoint}?${search.toString()}`, {
      headers: { authorization: `Bearer ${runtime.token}`, accept: 'application/json' },
      signal: combined,
    });
    if (response.ok) return await response.text();
  } catch {
    // 连接被拒：交给上层。
  }
  return undefined;
}

/**
 * 唤醒服务：跑 `serve --ensure`。
 *
 * **不能用退出码判成功，也不能在超时后 kill 子进程。** `serve --ensure`
 * 在服务不在跑时会把服务拉起来并**常驻不退出**（`src/main.ts:326-333`
 * 只写 stdout，没有 exit），所以等 close 永远等不到；超时到点 kill 掉的
 * 正是刚起来的那个服务——服务白起一次、被判失败、还被干掉。
 *
 * 正确做法：先探一次 `/healthz`，已在跑就直接成功；真要拉起时 spawn 出
 * 子进程就撒手（`detached` + `unref`，不 kill），再轮询健康检查，
 * 让服务自己说了算。
 */
async function wakeServe(signal: AbortSignal | undefined): Promise<boolean> {
  // 已经在跑：一次子进程都不起。
  if (await healthOnce(signal)) return true;

  const node = resolveNodeBinary();
  if (node === undefined) return false;
  // kernel 与服务入口在同一个 dist 目录，所以从 KERNEL_PATH 推出 main.js。
  const cliPath = KERNEL_PATH.replace(/kernel\.js$/, 'main.js');
  try {
    const child = spawn(node, [cliPath, 'serve', '--ensure'], {
      stdio: 'ignore',
      // 它是常驻服务，不该跟着 omp 的会话生命周期走。
      detached: true,
    });
    child.unref();
    // 只处理起不来（例如 node 不在 PATH）。起来之后就不管它了。
    child.on('error', () => {});
  } catch {
    return false;
  }

  // 轮询到通为止。
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref();
    });
    if (await healthOnce(signal)) return true;
  }
  return false;
}

/** 探一次本地服务的 `/healthz`。读不到 runtime.json 就是没起。 */
async function healthOnce(signal: AbortSignal | undefined): Promise<boolean> {
  const runtime = readServeRuntime();
  if (runtime === undefined) return false;
  try {
    const timeout = AbortSignal.timeout(2000);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, {
      headers: { Connection: 'close' },
      signal: combined,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 取一次搜索结果。**两级**：HTTP -> 唤醒并重试。
 *
 * 没有第三级「搜完就 spawn 一个一次性 kernel」：那条路绕过服务，
 * 让缓存与冷却状态失去意义，也等于给同一个查询维护第二套代码路径。
 * 服务起不来就返回 undefined，由上层给出可用性提示。
 */
async function fetchOrSpawn(args: string[], signal: AbortSignal | undefined): Promise<string | undefined> {
  const first = await tryServe(args, signal);
  if (first !== undefined) return first;

  if (await wakeServe(signal)) {
    const second = await tryServe(args, signal);
    if (second !== undefined) return second;
  }

  return undefined;
}

/**
 * 把 kernel 的输出翻译成 omp 的工具结果。
 *
 * 形状：`{ content: [{ type: 'text', text }], isError?, details? }`。
 * 文本用 Markdown 列表，模型读起来比裸 JSON 省 token。
 */
function toToolResult(raw: string): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 不是 JSON 说明 kernel 报了自己的一句话（KERNEL_FAILED …）。
    // 那句原文比「解析失败」有用，直接转给模型。
    return { content: [{ type: 'text', text: `搜索失败：${raw.slice(0, 300)}` }], isError: true };
  }

  const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const results = Array.isArray(root.results) ? root.results : [];
  const entry = typeof results[0] === 'object' && results[0] !== null ? (results[0] as Record<string, unknown>) : {};
  const items = Array.isArray(entry.items) ? entry.items : [];

  const lines: string[] = [];
  const summary = typeof entry.summary === 'string' ? entry.summary : undefined;
  if (summary !== undefined && summary !== '') {
    lines.push(summary, '');
  }

  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const hit = item as KernelHit;
    const url = typeof hit.url === 'string' ? hit.url : undefined;
    if (url === undefined) continue;
    const title = typeof hit.title === 'string' ? hit.title : url;
    lines.push(`- [${title}](${url})`);
    const snippet =
      typeof hit.snippet === 'string' ? hit.snippet : typeof hit.summary === 'string' ? hit.summary : undefined;
    if (snippet !== undefined && snippet !== '') {
      lines.push(`  ${snippet.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }

  if (lines.length === 0) {
    return { content: [{ type: 'text', text: '所有引擎都没有返回结果。' }], isError: true };
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export default function searchfuse(pi: ExtensionAPI): void {
  pi.registerTool({
    // 与内置同名：覆盖它。实测确认这个行为成立。
    name: 'web_search',
    label: 'Web Search',
    description:
      '搜索网页。多个搜索引擎并发查询并按相关性融合结果，返回带标题、链接与摘要的列表。',
    parameters: pi.zod.object({
      query: pi.zod.string().describe('要搜索的内容'),
    }),
    // essential：让它像内置工具一样出现在顶层工具列表，而不是藏在 tool search 后面。
    loadMode: 'essential',
    approval: 'read',
    execute: async (_toolCallId, params, signal) => {
      const raw = await fetchOrSpawn(['--query', params.query, '--source', 'web'], signal);
      if (raw === undefined) {
        return {
          content: [{ type: 'text', text: '搜索暂时不可用（超时或无法启动本地聚合器）。' }],
          isError: true,
        };
      }
      return toToolResult(raw);
    },
  });

  // x_search：X/Twitter 语料。与 web_search 同名不同源，dsh 与 Claude 侧
  // 都有同一个能力，这里补齐以免 omp 成为唯一缺它的宿主。
  pi.registerTool({
    name: 'x_search',
    label: 'X Search',
    description: '搜索 X（Twitter）上的帖子。与网页搜索分开走语料链路。',
    parameters: pi.zod.object({
      query: pi.zod.string().describe('要搜索的内容'),
    }),
    loadMode: 'essential',
    approval: 'read',
    execute: async (_toolCallId, params, signal) => {
      const raw = await fetchOrSpawn(['--query', params.query, '--source', 'x'], signal);
      if (raw === undefined) {
        return { content: [{ type: 'text', text: 'X 搜索暂时不可用。' }], isError: true };
      }
      return toToolResult(raw);
    },
  });

  // read_page：抓取并消化一个页面（正文摘出来，不是原始 HTML）。
  pi.registerTool({
    name: 'read_page',
    label: 'Read Page',
    description: '读取一个网页并返回它的正文摘要与链接。',
    parameters: pi.zod.object({
      url: pi.zod.string().describe('要读取的页面地址'),
    }),
    loadMode: 'essential',
    approval: 'read',
    execute: async (_toolCallId, params, signal) => {
      const raw = await fetchOrSpawn(['--url', params.url], signal);
      if (raw === undefined) {
        return { content: [{ type: 'text', text: '页面读取暂时不可用。' }], isError: true };
      }
      return toToolResult(raw);
    },
  });
}
