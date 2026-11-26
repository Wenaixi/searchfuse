import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, withTempHome } from './testing/helpers.ts';

const originalArgv = process.argv;
const originalElectronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const originalNested = process.env.MODSEARCH_NESTED;
let restoreHome: (() => void) | undefined;

afterEach(() => {
  process.argv = originalArgv;
  if (originalElectronRunAsNode === undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } else {
    process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  }
  if (originalNested === undefined) {
    delete process.env.MODSEARCH_NESTED;
  } else {
    process.env.MODSEARCH_NESTED = originalNested;
  }
  if (originalElectronDescriptor) {
    Object.defineProperty(process.versions, 'electron', originalElectronDescriptor);
  } else {
    Reflect.deleteProperty(process.versions, 'electron');
  }
  restoreHome?.();
  restoreHome = undefined;
  cleanupTempDirs();
  vi.restoreAllMocks();
  vi.resetModules();
});

// 这个文件里凡是 `import('./main.ts')` 的用例都要放宽超时：那次导入要把
// commander、全部 provider 与 MCP 客户端一起拉起来，低配机器上单是模块加载
// 就能超过 vitest 默认的 5 秒。并行跑全量时 CPU 被别的文件抢走，超时最先在
// 这里发生，而报出来的是 STACK_TRACE_ERROR，看不出根因。
const SLOW_IMPORT = { timeout: 30_000 } as const;

describe('CLI entry point', () => {
  it('uses Node argv layout when Electron runs as Node', SLOW_IMPORT, async () => {
    ({ restore: restoreHome } = withTempHome());
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.argv = [
      process.execPath,
      '/package/dist/main.js',
      'doctor',
      '--json',
    ];
    Object.defineProperty(process.versions, 'electron', {
      value: '43.4.0',
      configurable: true,
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${code})`);
    });

    await import('./main.ts');

    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      node: { ok: true },
      roles: expect.any(Array),
    });
  });

  it('refuses to run when spawned from inside an engine', SLOW_IMPORT, async () => {
    process.env.MODSEARCH_NESTED = '1';
    process.argv = [process.execPath, '/package/dist/main.js', 'doctor', '--json'];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(import('./main.ts')).rejects.toThrow(/process\.exit\(1\)/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls.map((call) => call[0]).join(''))).toContain(
      'searchfuse refused to run: it was started from inside an engine that searchfuse itself spawned (recursion guard).',
    );
  });
});

/** A stream write stub that reports the chunk as flushed, as a real stream would. */
function acceptWrite(...args: unknown[]): boolean {
  const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
  callback?.();
  return true;
}

describe('search flags', () => {
  async function runCli(args: string[], pendingKills: Promise<void> = Promise.resolve()) {
    const runSearch = vi.fn(async () => ({ mode: 'search', results: [], meta: {} }));
    vi.doMock('./search.ts', () => ({ runSearch }));
    const waitForPendingKills = vi.fn(() => pendingKills);
    vi.doMock('./subprocess.ts', () => ({ waitForPendingKills }));
    ({ restore: restoreHome } = withTempHome());
    process.argv = [process.execPath, '/package/dist/main.js', ...args];
    vi.spyOn(process.stdout, 'write').mockImplementation(acceptWrite);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(acceptWrite);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // The entry awaits the whole action at top level, pending kills included,
    // so the import is not awaited here: a test may be holding those kills.
    const loading = import('./main.ts');
    await vi.waitFor(
      () => {
        expect(runSearch.mock.calls.length + stderr.mock.calls.length).toBeGreaterThan(0);
      },
      { timeout: 25_000 },
    );
    return { runSearch, stderr, exit, waitForPendingKills, loading };
  }

  afterEach(() => {
    vi.doUnmock('./search.ts');
    vi.doUnmock('./subprocess.ts');
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  it('passes --deadline through as the run-wide budget', SLOW_IMPORT, async () => {
    const { runSearch } = await runCli([
      '-q',
      'anything',
      '--timeout',
      '40000',
      '--deadline',
      '55000',
    ]);
    // The clock starts at process start: a slow Node boot spends the same
    // budget the caller is holding.
    expect(runSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 40_000,
        deadlineMs: 55_000,
        deadlineStartedAt: performance.timeOrigin,
      }),
    );
  });

  it('lets the event loop drain after pending engine kills land', SLOW_IMPORT, async () => {
    // Exiting on the spot tore down fetch sockets mid-close, which aborts Node
    // on Windows (libuv async.c assertion, exit 0xC0000409) after a good
    // result was already written (#38). So the CLI sets its exit code and lets
    // the loop end the process. It waits for a pending SIGKILL first, or the
    // exit would orphan an engine that ignored SIGTERM.
    // fake timers 必须**在导入 main.ts 之前**就装上。main.ts 在顶层设了一个
    // 2 秒的退出 backstop（`setTimeout(...).unref()`）；这台机器上
    // `import('./main.ts')` 本身就要几秒，backstop 会在真实时间里先触发，
    // 于是 `exit` 被调用，而这条测试要证的正是「不该调 exit」。装成假时钟后
    // 那段耗时只花在别的定时器上，backstop 只能被 runOnlyPendingTimers 触发。
    vi.useFakeTimers();
    let releaseKills = () => {};
    const pendingKills = new Promise<void>((resolve) => {
      releaseKills = resolve;
    });
    const { exit, waitForPendingKills, loading } = await runCli(['-q', 'anything'], pendingKills);
    await vi.waitFor(() => expect(waitForPendingKills).toHaveBeenCalled());
    releaseKills();
    await loading;
    expect(process.exitCode).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    // Abandoned work (a DNS lookup nobody answers) may still hold the loop,
    // so a backstop ends the process anyway.
    vi.runOnlyPendingTimers();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('leaves the run uncapped without --deadline', SLOW_IMPORT, async () => {
    const { runSearch } = await runCli(['-q', 'anything']);
    expect(runSearch).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: undefined }));
  });

  it('rejects a --deadline that is not a positive integer', SLOW_IMPORT, async () => {
    const { runSearch, stderr, loading } = await runCli(['-q', 'anything', '--deadline', '0']);
    await loading;
    expect(process.exitCode).toBe(1);
    expect(runSearch).not.toHaveBeenCalled();
    expect(String(stderr.mock.calls.map((call) => call[0]).join(''))).toContain(
      'Invalid --deadline',
    );
  });
});
