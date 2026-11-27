// 服务身份的确定性推导。
//
// 为什么需要它：`runtime.json` 曾经是唯一的服务身份凭证，而它在 close() 里被
// 删除（serve.ts 的优雅退出），进程被信号杀掉或崩溃时又来不及删。于是出现
// 「服务还在听、文件已经没了」的僵尸态——实测 PID 27056 监听 64683 而
// runtime.json 不存在，三端全部读不到端口，退回 spawn 慢路径。文件是这个
// 设计的单点故障。
//
// 这里把身份从「一个可能消失的文件」改成「从目录推导出来的一组候选端口」：
// 同一个 `~/.searchfuse` 目录永远算出同一组候选，服务优先绑第一个可用的，
// 客户端按同一顺序逐个探测并校验指纹。文件降级为缓存。
//
// **三端各有一份拷贝**（src / dsh / claude），因为 dsh 有独立构建 rootDir、
// claude 的 mod 沙箱不允许 import 非相对模块。三份必须逐字一致，由
// serveIdentity.parity.test.ts 锁住——那是这套设计唯一的防漂移手段。

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 候选端口的起点。选这一段是为了避开常见服务端口，且远离临时端口区。 */
export const PORT_BASE = 42_000;

/** 候选端口数量。8 个连续端口，给同机多实例留余量，又不至于扫描太久。 */
export const PORT_SPAN = 8;

/** 目录指纹的长度（十六进制字符）。8 位 = 32 位空间，碰撞概率可忽略。 */
const FINGERPRINT_CHARS = 8;

/**
 * 算出一个状态目录的指纹。
 *
 * 用 `realpathSync` 而不是 `path.resolve`：Windows 上 `C:\Users\Administrator`
 * 与 `C:\Users\ADMINI~1`（8.3 短名）是**同一个目录**，junction 与它指向的
 * 目标也是同一个。用 resolve 会给出两组不同的指纹，于是同一份状态被认成
 * 两个身份——服务绑在一组候选上、客户端去探另一组，症状与「服务没起来」
 * 一模一样。
 *
 * 目录还没建出来时 realpath 会抛 ENOENT：那时退回 resolve，因为那种情况下
 * 没有「另一个写法」可言。大小写仍要统一（`C:\Users` 与 `c:\users` 在
 * Windows 上相等）。
 */
export function fingerprintOf(stateDir: string): string {
  const resolved = realpathOrSelf(stateDir);
  return createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, FINGERPRINT_CHARS);
}

/** realpath 拿不到（目录不存在、权限不足）时退回 resolve。 */
function realpathOrSelf(stateDir: string): string {
  try {
    return fs.realpathSync(stateDir);
  } catch {
    return path.resolve(stateDir);
  }
}

/**
 * 从指纹推出一组候选端口，按优先级从高到低。
 *
 * 确定性：同一个指纹永远给出同一组。跨进程、跨宿主、跨重启都一样。
 */
export function candidatePorts(fingerprint: string): number[] {
  const seed = Number.parseInt(fingerprint, 16);
  // 指纹是 32 位，取其低位并限定在一个窄带上，保证端口在合法范围内且不越界。
  const base = PORT_BASE + (seed % 2_000);
  const ports: number[] = [];
  for (let i = 0; i < PORT_SPAN; i += 1) {
    const port = base + i;
    // 65535 之上不是合法端口。窄带设计下不会发生，但算式不该靠「不会发生」。
    if (port <= 65_535) ports.push(port);
  }
  return ports;
}

/** 状态目录：与其他模块的 `.searchfuse` 保持同一份约定。 */
export function stateDirOf(home: string): string {
  return path.join(home, '.searchfuse');
}

/** 一次推导的完整结果，便于三端共用同一套字段。 */
export interface ServeIdentity {
  fingerprint: string;
  ports: number[];
}

/** 从一个 home 目录推出服务身份。 */
export function identityOf(home: string): ServeIdentity {
  const fingerprint = fingerprintOf(stateDirOf(home));
  return { fingerprint, ports: candidatePorts(fingerprint) };
}
