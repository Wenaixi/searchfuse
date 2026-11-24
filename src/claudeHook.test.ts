// Claude Code mod 的 hook 从没被测试覆盖过，而它是三个宿主里唯一没有
// 自愈能力的那一侧。这个文件只钉住一件事：服务不在、子进程也失败时，
// hook 会跑一次 `serve --ensure` 再试。
//
// 为什么不能走 `src/serveEnsure.ts`：mod 沙箱里 `globalThis.process` 是
// undefined（实测），拿不到 `process.execPath`，也读不到 HOME。所以它只能
// 用宿主给的 `$.settings.read` / `$.fs.read` / `$.process.run` 三件套。
// 这个测试就把那三件套换成可观察的桩。
import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../claude/hooks/register.ts';

/** 宿主 `$` 的最小替身：只实现 hook 真正会调的那几个。 */
interface Stub {
  settings: Record<string, unknown>;
  /** 每次 `$.process.run` 的 argv。 */
  runs: string[][];
  /** `$.fs.read` 的返回值，按路径索引。 */
  files: Record<string, string>;
  /** process.run 的退出码策略。 */
  exitCodeFor: (argv: string[]) => number;
}

function makeDollar(stub: Stub): unknown {
  return {
    settings: {
      read: async ({ key }: { key: string }) => stub.settings[key],
    },
    fs: {
      read: async (path: string) => {
        const value = stub.files[path];
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
    },
    process: {
      run: async ({ argv }: { argv: string[] }) => {
        stub.runs.push(argv);
        return { stdout: '', stderr: '', exitCode: stub.exitCodeFor(argv) };
      },
    },
    http: {
      fetch: async () => {
        throw new Error('unreachable');
      },
    },
  };
}

type WebSearchHandler = ($: unknown, e: unknown, next: unknown) => Promise<unknown>;

/** 捕获 `register` 挂到 `tool.call` 上的 WebSearch handler。 */
function captureHandler(): WebSearchHandler | undefined {
  let captured: WebSearchHandler | undefined;
  // 宿主的 `on(...)` 返回一个可继续 `.catch()` 的注册句柄（用来挂错误回退）。
  // 桩必须复现这一点，否则 register 一进来就会 TypeError。
  const registration = {
    catch: () => registration,
  };
  const on = (event: string, matcherOrHandler: unknown, maybeHandler?: unknown): unknown => {
    const matcher = typeof matcherOrHandler === 'object' ? matcherOrHandler : undefined;
    const handler = (matcher === undefined ? matcherOrHandler : maybeHandler) as
      | (($: unknown, e: unknown, next: unknown) => Promise<unknown>)
      | undefined;
    if (
      event === 'tool.call' &&
      matcher !== undefined &&
      (matcher as { tool?: string }).tool === 'WebSearch'
    ) {
      captured = handler;
    }
    return registration;
  };
  register(on as never, {});
  return captured;
}

const KERNEL_PATH = 'E:\\x\\dist\\kernel.js';
const RUNTIME_PATH = 'E:\\x\\runtime.json';

describe('Claude hook 的第三级兜底', () => {
  let stub: Stub;

  beforeEach(() => {
    stub = {
      // 开关开着、两条绝对路径都在：这是 `hosts sync` 之后的状态。
      settings: {
        searchfuseHosts: {
          claudeCode: { enabled: true, runtimePath: RUNTIME_PATH, kernelPath: KERNEL_PATH },
        },
      },
      runs: [],
      files: {},
      exitCodeFor: () => 0,
    };
  });

  it('服务不在、子进程也失败时，跑 serve --ensure 并从 kernel 推出 CLI 路径', async () => {
    // runtime.json 读不到 → 路径一跳过。
    stub.files = {};
    // 子进程失败 → 路径二失败。第一 argv 是 kernel，第二个应该是 serve。
    stub.exitCodeFor = (argv) => (argv.includes('serve') ? 0 : 1);
    const handler = captureHandler();
    expect(handler).toBeDefined();

    // next 是可调用对象，同时带 signal：hook 会 next.signal 传给子进程。
    const nextCalls: unknown[] = [];
    const next = Object.assign((event: unknown) => { nextCalls.push(event); }, { signal: undefined });
    await handler!(makeDollar(stub), { query: 'anything' }, next);

    // 两次 process.run：一次 kernel 兜底、一次 serve --ensure。
    expect(stub.runs).toHaveLength(2);
    expect(stub.runs[0][1]).toBe(KERNEL_PATH);
    // CLI 入口从 kernel 推出来，不是另写一份。
    expect(stub.runs[1][1]).toBe('E:\\x\\dist\\main.js');
    expect(stub.runs[1]).toContain('serve');
    expect(stub.runs[1]).toContain('--ensure');
  });

  it('kernel 路径不像 kernel.js 时不猜，直接放弃', async () => {
    stub.settings = {
      searchfuseHosts: { claudeCode: { enabled: true, runtimePath: RUNTIME_PATH, kernelPath: 'E:\\x\\other.js' } },
    };
    stub.files = {};
    stub.exitCodeFor = () => 1;
    const handler = captureHandler();
    // next 是可调用对象，同时带 signal：hook 会 next.signal 传给子进程。
    const nextCalls: unknown[] = [];
    const next = Object.assign((event: unknown) => { nextCalls.push(event); }, { signal: undefined });
    await handler!(makeDollar(stub), { query: 'anything' }, next);

    // 只跑了一次 kernel，没有第二次 serve。
    expect(stub.runs).toHaveLength(1);
  });

  it('服务在跑时不走子进程，也不拉起', async () => {
    // runtime.json 存在且 healthz 会通。
    const dollar = {
      settings: {
        read: async () => stub.settings.searchfuseHosts,
      },
      fs: { read: async () => '{"port": 12345, "token": "abc"}' },
      process: {
        run: async ({ argv }: { argv: string[] }) => {
          stub.runs.push(argv);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
      http: {
        fetch: async () => ({ ok: true, text: async () => '{"results":[]}' }),
      },
    };
    const handler = captureHandler();
    // next 是可调用对象，同时带 signal：hook 会 next.signal 传给子进程。
    const nextCalls: unknown[] = [];
    const next = Object.assign((event: unknown) => { nextCalls.push(event); }, { signal: undefined });
    await handler!(dollar, { query: 'anything' }, next);

    // 一条 process.run 都没有：服务答了就收工。
    expect(stub.runs).toHaveLength(0);
  });
});
