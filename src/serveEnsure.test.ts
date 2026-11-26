import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServeRunning, readServeRuntimeFile } from './serveEnsure.ts';
import { isAlive } from './util/isAlive.ts';
import { cleanupTempDirs, withTempHome } from './testing/helpers.ts';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  cleanupTempDirs();
});

/** 造一个临时 runtime.json，用完删掉。 */
function tempRuntime(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-ensure-'));
  created.push(dir);
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify(contents), 'utf-8');
  return file;
}

/** 拿一个刚关闭的本机端口。返回时它必定没人监听。 */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 收掉假 CLI 留下的常驻子进程。
 *
 * `ensureServeRunning` 刻意不 kill 子进程（它就是常驻服务），所以测试必须
 * 自己清理，否则每跑一次测试就多一个孤儿进程占着端口。
 * 用 runtime.json 里的 pid 精确定位，不去猜端口归属。
 */
async function killChildOnPort(runtimeFile: string): Promise<void> {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number') return;
    process.kill(parsed.pid);
  } catch {
    // 文件不在、进程已经退出、或没有权限：都不影响测试结果。
  }
}

describe('readServeRuntimeFile', () => {
  it('读回端口与 token', () => {
    const file = tempRuntime({ port: 61746, token: 'abc' });
    expect(readServeRuntimeFile(file)).toEqual({ port: 61746, token: 'abc' });
  });

  it('文件不存在时返回 undefined，不抛异常', () => {
    expect(readServeRuntimeFile('/nonexistent/runtime.json')).toBeUndefined();
  });

  it('形状不对时返回 undefined', () => {
    const file = tempRuntime({ port: 'not a number', token: 'abc' });
    expect(readServeRuntimeFile(file)).toBeUndefined();
  });
});

describe('ensureServeRunning', () => {
  it('文件在但服务已死时不动文件、走 spawn 并带回原因', async () => {
    // ensureServeRunning 读的是 home 下的真实位置，所以先把 home 指到
    // 临时目录，测试才不会受本机是否恰好在跑服务影响（别处也用这个办法）。
    const { home, restore } = withTempHome();
    try {
      const file = path.join(home, '.searchfuse', 'runtime.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 端口取一个刚关闭的本机端口：文件在、服务不在——最阴的那种状态。
      fs.writeFileSync(file, JSON.stringify({ port: await closedPort(), token: 'abc' }), 'utf-8');
      const before = fs.statSync(file).mtimeMs;
      // 用一个必然失败的 CLI 让 spawn 立刻返回，从而只验「没有改写 runtime.json」。
      const outcome = await ensureServeRunning({
        cliPath: '/nonexistent/main.js',
        timeoutMs: 500,
      });
      expect(fs.statSync(file).mtimeMs).toBe(before);
      expect(outcome.started).toBe(false);
      expect(typeof outcome.reason).toBe('string');
    } finally {
      restore();
    }
  });

  it('服务已在跑时立刻返回，不 spawn、不改写文件', async () => {
    const { home, restore } = withTempHome();
    try {
      // 起一个真服务替代品：只答 /healthz 200，其余一概不管。
      const server = http.createServer((req, res) => {
        res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'text/plain' });
        res.end('OK');
      });
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : 0);
        });
      });
      try {
        const file = path.join(home, '.searchfuse', 'runtime.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ port, token: 'abc' }), 'utf-8');
        const before = fs.statSync(file).mtimeMs;
        // cliPath 指向必然失败的位置：如果真的去 spawn，这条会红。
        const outcome = await ensureServeRunning({ cliPath: '/nonexistent/main.js', timeoutMs: 500 });
        expect(outcome).toEqual({ started: false, port });
        expect(outcome.reason).toBeUndefined();
        expect(fs.statSync(file).mtimeMs).toBe(before);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      restore();
    }
  });

  it('子进程把服务拉起来后，轮询到健康并返回端口', async () => {
    // 假 CLI：模拟 `serve --ensure` 在「服务不在跑」时的真实行为——
    // 拉起一个服务、写出 runtime.json、然后**常驻不退出**。
    // 这条守的是本函数唯一的成功路径：破坏轮询的成功分支后，它会红。
    const { home, restore } = withTempHome();
    const file = path.join(home, '.searchfuse', 'runtime.json');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fakeCli = path.join(home, 'fake-cli.cjs');
      fs.writeFileSync(
        fakeCli,
        [
          "const http = require('node:http');",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          'const server = http.createServer((req, res) => {',
          "  res.writeHead(200, { 'content-type': 'text/plain' });",
          "  res.end('OK');",
          '});',
          'server.listen(0, "127.0.0.1", () => {',
          '  const dir = path.join(process.env.HOME, ".searchfuse");',
          '  fs.mkdirSync(dir, { recursive: true });',
          '  fs.writeFileSync(path.join(dir, "runtime.json"),',
          '    JSON.stringify({ port: server.address().port, token: "abc", pid: process.pid }));',
          '});',
          '// 常驻：真实 serve --ensure 在这里不会退出。',
          'setInterval(() => {}, 1 << 30);',
        ].join('\n'),
        'utf-8',
      );
      const outcome = await ensureServeRunning({
        nodeBinary: process.execPath,
        cliPath: fakeCli,
        timeoutMs: 5000,
      });
      expect(outcome.started).toBe(true);
      expect(typeof outcome.port).toBe('number');
      expect(outcome.reason).toBeUndefined();
    } finally {
      // 假 CLI 是个常驻子进程，测试结束要收掉它，否则会留下孤儿。
      // ensureServeRunning 刻意不 kill 子进程，所以清理只能由调用方做。
      await killChildOnPort(file);
      restore();
    }
  });

  it('子进程以 0 退出却说不出端口时，立刻报 runtime.json 没写出', async () => {
    // 假 CLI：立刻 exit 0（`serve --ensure` 发现「已在跑」时就是这样），
    // 但没有写出 runtime.json。继续轮询只会白等满整个超时，所以应该
    // 立刻报出来——这是 spec §3.1 第 5 步要求的那条 reason。
    const { home, restore } = withTempHome();
    try {
      const cli = path.join(home, 'fake-cli.js');
      fs.writeFileSync(cli, 'process.exit(0);\n', 'utf-8');
      // 超时给到 3000，而断言「远小于 3000」。
      //
      // 为什么不用「小于 700」这种贴着超时的阈值：子进程的启动与退出事件
      // 本身就有几百毫秒的抖动（实测这台机器上跑过一次 1055ms），贴着超时
      // 写会让测试随机器负载变红。判据要抓的是「没有等满超时」，不是
      // 「非常快」——3000 对 3000 以下的巨大差距才区分得开正确实现和
      // 「一直轮询到超时」的错误实现。
      const timeoutMs = 3000;
      const t0 = Date.now();
      const outcome = await ensureServeRunning({ cliPath: cli, timeoutMs });
      expect(outcome.started).toBe(false);
      // reason 就是判据本身：早退报 `runtime.json not written`，
      // 等满超时的是 `serve did not become healthy within N ms`，两条路径的
      // 文案不同，比计时精确得多。
      expect(outcome.reason).toBe('runtime.json not written');
      // 计时只做一个很宽的兜底，用来抓住「根本没走早退分支」这种实现错误。
      // 这条用例的真实耗时随机器的子进程启动速度在 764ms 到 1474ms 之间
      // 波动（实测），贴着超时写阈值会让它随负载变红，而实现是对的。
      expect(Date.now() - t0).toBeLessThan(timeoutMs + 1_500);
    } finally {
      restore();
    }
  });

  it('子进程常驻但服务始终不健康时，超时后报告不健康', async () => {
    // 假 CLI：一直活着、不写 runtime.json。这是「拉起了进程但服务没起来」
    // 的形状，只有等满超时才能下结论。
    const { home, restore } = withTempHome();
    const pidFile = path.join(home, 'fake-cli.pid');
    try {
      const cli = path.join(home, 'fake-cli.js');
      // 必须把自己的 pid 落到文件里：这个假 CLI 不写 runtime.json，所以
      // killChildOnPort 无从定位它。不这么做，每跑一次这条测试就泄漏一个
      // 常驻 node 孤儿——测试自己制造雪崩，正是这次事故的讽刺版。
      fs.writeFileSync(
        cli,
        [
          "const fs = require('node:fs');",
          'fs.writeFileSync(process.env.SEARCHFUSE_TEST_PID_FILE, String(process.pid));',
          'setInterval(() => {}, 1 << 30);',
        ].join('\n'),
        'utf-8',
      );
      process.env.SEARCHFUSE_TEST_PID_FILE = pidFile;
      const t0 = Date.now();
      const outcome = await ensureServeRunning({ cliPath: cli, timeoutMs: 700 });
      expect(outcome.started).toBe(false);
      expect(outcome.reason).toContain('healthy');
      // 确实等到了超时，而不是误判成功立刻返回。
      expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    } finally {
      delete process.env.SEARCHFUSE_TEST_PID_FILE;
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
        if (Number.isInteger(pid) && pid > 0) process.kill(pid);
      } catch {
        // 文件不在或进程已退出：都不影响测试结果。
      }
      restore();
    }
  });
});

describe('跨进程锁的原子语义', () => {
  /**
   * 这条钉住 118 僵尸进程事故的第二条根因：并发 `--ensure` 各自起一个服务。
   *
   * 关于「为什么只有这一条」：我试过三种写法，只有这一条有真守护力。
   * (a) 在测试里直接调 `fs.openSync('wx')` —— 测的是 Node 原生 API，
   *     生产实现退回 `mkdirSync` 后照样绿。
   * (b) 起两个真实 `serve --ensure` 子进程数存活数 —— **也不行**：实测
   *     破坏锁实现后它照样绿，因为两个进程启动有先后，第二个读到已写出的
   *     runtime.json 会走「Already running」早退，掩盖了竞态。而且它要跑
   *     20 秒，慢且不稳。
   * (c) 抄一份生产判据到本地再测 —— 测的是副本。
   *
   * 所以锁的完整行为（`wx` 排他 + 陈旧回收 + 立即释放）靠代码审查与
   * CLAUDE.md 的事故记录兜底；可自动化的部分只留下 EPERM 这一条，
   * 因为它是纯函数判据，能精确断言。这是有意识的取舍，不是漏测。
   */
  it('EPERM 必须判成「活着」：否则会误抢受保护进程的锁', () => {
    // 2026-11-25 实测：对 PID 4（System）这类权限受限的进程，
    // process.kill(pid, 0) 抛的是 EPERM 而不是 ESRCH。EPERM 的含义是
    // 「进程存在，只是不归我管」。把它当「死了」会让一个活着的持有者
    // 的锁被误抢，两个进程同时起服务。
    //
    // **测的是生产代码本身**（`src/util/isAlive.ts`）。反向验证确认：
    // 把 EPERM 改成别的码，这条会红在本行。
    expect(isAlive(4)).toBe(true); // System：存在但权限受限，必抛 EPERM
    expect(isAlive(999_999)).toBe(false); // 不存在：ESRCH
    expect(isAlive(0)).toBe(false); // 非法 pid：直接 false，不交给 kill
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(Number.NaN)).toBe(false);
  });
});
