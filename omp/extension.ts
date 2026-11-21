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
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';

/** 渲染时替换成真实的绝对路径。 */
const KERNEL_PATH = '__SEARCHFUSE_KERNEL_PATH__';

/** 一次搜索的墙钟上限。比聚合默认的 8 秒宽，留给慢引擎。 */
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
function runKernel(args: string[], signal: AbortSignal | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const nodeBinary = resolveNodeBinary();
    if (nodeBinary === undefined) {
      finish('NO_NODE: cannot find a Node.js executable; set SEARCHFUSE_NODE');
      return;
    }

    let child;
    try {
      child = spawn(nodeBinary, [KERNEL_PATH, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(undefined);
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // stderr 不参与解析，但要不读就会在缓冲区满时阻塞子进程；失败时它有用。
    let stderrText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, SEARCH_TIMEOUT_MS);
    timer.unref();

    const onAbort = (): void => {
      child.kill();
      finish(undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // 失败时把 stderr 交出去：内部错误信息比一句「搜索不可用」有用得多。
      finish(code === 0 ? stdout : `KERNEL_FAILED exit=${code ?? '?'} ${stderrText.slice(0, 300)}`);
    });
  });
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
      const raw = await runKernel(['--query', params.query, '--source', 'web'], signal);
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
      const raw = await runKernel(['--query', params.query, '--source', 'x'], signal);
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
      const raw = await runKernel(['--url', params.url], signal);
      if (raw === undefined) {
        return { content: [{ type: 'text', text: '页面读取暂时不可用。' }], isError: true };
      }
      return toToolResult(raw);
    },
  });
}
