import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServeRunning, readServeRuntimeFile } from './serveEnsure.ts';
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
});
