// 「同目录 = 同服务」的守护测试。
//
// 这次改造要证明的核心承诺只有一条：**runtime.json 不再是唯一凭证**。
// 服务被 kill 时 close() 跑不到，文件会消失；但只要服务还在候选端口上听着，
// 客户端就必须靠目录指纹把它找回来。这里的用例就是逐条钉住这个承诺。
//
// 全部用真实 HTTP 服务（startServe）而不是桩：指纹校验、候选探测、
// token 读取三者串起来的行为，桩测不出来。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServeToken, startServe } from './serve.ts';
import { discoverServe, ensureServeRunning } from './serveEnsure.ts';
import { candidatePorts, fingerprintOf, identityOf, stateDirOf } from './serveIdentity.ts';
import { cleanupTempDirs, withTempHome } from './testing/helpers.ts';

let restore: (() => void) | undefined;
const openHandles: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    try {
      await handle.close();
    } catch {
      // 已经关掉：不影响结论。
    }
  }
  restore?.();
  restore = undefined;
  cleanupTempDirs();
});

/** 在一个临时 home 里起一份服务，返回句柄与推导出的身份。 */
async function serveInTempHome(): Promise<{
  home: string;
  fingerprint: string;
  ports: number[];
  port: number;
  token: string;
}> {
  const temp = withTempHome();
  restore = temp.restore;
  const identity = identityOf(temp.home);
  // 与真实启动一致：token 先落盘到 serve-token，服务端与客户端共用同一份。
  const token = ensureServeToken();
  const handle = await startServe({
    port: 0,
    token,
    idleExitSeconds: 0,
    fingerprint: identity.fingerprint,
    candidatePorts: identity.ports,
  });
  openHandles.push(handle);
  return { home: temp.home, fingerprint: identity.fingerprint, ports: identity.ports, port: handle.port, token };
}

describe('同目录 = 同服务', () => {
  it('服务绑定的端口落在该目录推导出的候选里', async () => {
    const served = await serveInTempHome();
    expect(served.ports).toContain(served.port);
  });

  it('runtime.json 被删掉后，仍能靠指纹把服务找回来', async () => {
    // 这是整个改造的核心承诺。模拟「服务被 kill、close 没跑到、文件消失」：
    const served = await serveInTempHome();
    const runtimeFile = path.join(stateDirOf(served.home), 'runtime.json');
    expect(fs.existsSync(runtimeFile)).toBe(true);
    fs.rmSync(runtimeFile);

    const found = await discoverServe(served.fingerprint, served.ports);
    expect(found).toBeDefined();
    expect(found?.port).toBe(served.port);
    // token 从 serve-token 文件读回来，服务端与客户端共用同一份。
    expect(found?.token).toBe(served.token);
  });

  it('ensureServeRunning 在文件缺失时也能认出已在跑的服务，不另起一个', async () => {
    const served = await serveInTempHome();
    const runtimeFile = path.join(stateDirOf(served.home), 'runtime.json');
    fs.rmSync(runtimeFile);

    const outcome = await ensureServeRunning();
    // started 必须是 false：服务已经在跑，起第二个就是雪崩的起点。
    expect(outcome.started).toBe(false);
    expect(outcome.port).toBe(served.port);
  });

  it('陌生服务占着候选端口时不会被认成自己的服务', async () => {
    // 只校验 /healthz 200 的实现会在这里误连——然后把 token 发给陌生程序。
    // 指纹校验必须挡住它。
    const stranger = withTempHome();
    const strangerIdentity = identityOf(stranger.home);
    const handle = await startServe({
      port: 0,
      token: 'stranger-token',
      idleExitSeconds: 0,
      fingerprint: strangerIdentity.fingerprint,
      candidatePorts: strangerIdentity.ports,
    });
    openHandles.push(handle);
    stranger.restore();

    // 用另一份 home 的指纹去探这个端口：必须找不到。
    const other = withTempHome();
    restore = other.restore;
    const otherIdentity = identityOf(other.home);
    const found = await discoverServe(otherIdentity.fingerprint, [handle.port]);
    expect(found).toBeUndefined();
  });

  it('两个 home 推导出的候选互不相同时，不会互相串台', async () => {
    const a = identityOf('/home/a');
    const b = identityOf('/home/b');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    // 候选可以重叠（窄带设计），但指纹不同就永远认不到对方。
    expect(a.ports).toEqual(candidatePorts(a.fingerprint));
    expect(b.ports).toEqual(candidatePorts(b.fingerprint));
  });

  it('/identity 报出的指纹与目录推导一致', async () => {
    const served = await serveInTempHome();
    const res = await fetch(`http://127.0.0.1:${served.port}/identity`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fingerprint?: unknown; port?: unknown; pid?: unknown };
    expect(body.fingerprint).toBe(served.fingerprint);
    expect(body.port).toBe(served.port);
    expect(typeof body.pid).toBe('number');
  });

  it('/healthz 的 body 保持纯文本 OK（四个现存消费者都只看状态码）', async () => {
    const served = await serveInTempHome();
    const res = await fetch(`http://127.0.0.1:${served.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('候选端口被占时向后顺延，而不是随机漂走', async () => {
    const temp = withTempHome();
    restore = temp.restore;
    const identity = identityOf(temp.home);
    // 先用掉第一个候选。
    const first = await startServe({
      port: 0,
      token: 'a',
      idleExitSeconds: 0,
      fingerprint: identity.fingerprint,
      candidatePorts: [identity.ports[0]!],
    });
    openHandles.push(first);
    expect(first.port).toBe(identity.ports[0]);

    // 第二个实例拿到完整候选，必须落到后面的某个，而不是别的随机端口。
    const second = await startServe({
      port: 0,
      token: 'b',
      idleExitSeconds: 0,
      fingerprint: identity.fingerprint,
      candidatePorts: identity.ports,
    });
    openHandles.push(second);
    expect(second.port).not.toBe(first.port);
    expect(identity.ports).toContain(second.port);
  });
});
