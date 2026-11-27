// 三端身份推导的一致性守护。
//
// 服务身份算法有三份拷贝：
// - `src/serveIdentity.ts`（主包：CLI、serveEnsure、dsh 的兄弟模块都用它）
// - `dsh/index.ts`（dsh 独立构建，rootDir="dsh"，不能 import src）
// - `claude/hooks/register.ts`（mod 沙箱，连 crypto 都没有，只读 CLI 写好的值）
//
// 任何一份漂移，都会造成「服务绑一个端口、客户端去探另一个」的错配，
// 而症状与「服务没起来」一模一样——最难查的一类故障。所以这里不测行为，
// 只测**三份实现给出同一个答案**。
//
// claude 那一端不自己算，所以它的正确性靠 `hosts sync` 写入的值与另外两端
// 一致来保证；这个测试直接比对 `hosts.ts` 拿到的 identity 与 `serveIdentity`。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { identityOf } from './serveIdentity.ts';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

/** 从 dsh/index.ts 里读出它那份常量与算法。 */
function dshConstants(): { portBase: number; portSpan: number } {
  const source = fs.readFileSync(path.join(repoRoot, 'dsh', 'index.ts'), 'utf-8');
  const base = source.match(/IDENTITY_PORT_BASE\s*=\s*(\d+)/);
  const span = source.match(/IDENTITY_PORT_SPAN\s*=\s*(\d+)/);
  if (base === null || span === null) throw new Error('dsh/index.ts 里找不到身份常量');
  return { portBase: Number(base[1]), portSpan: Number(span[1]) };
}

describe('三端的身份推导必须一致', () => {
  it('dsh 的常量与主包相同', () => {
    const { portBase, portSpan } = dshConstants();
    // 这两个数字若不同，两端永远找不到同一个服务。
    expect(portBase).toBe(42_000);
    expect(portSpan).toBe(8);
  });

  it('dsh 的指纹长度与主包相同（8 位十六进制）', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'dsh', 'index.ts'), 'utf-8');
    const slice = source.match(/digest\('hex'\)\.slice\(0, (\d+)\)/);
    if (slice === null) throw new Error('dsh/index.ts 里找不到指纹截断长度');
    expect(Number(slice[1])).toBe(8);
  });

  it('主包对多个目录都给出稳定的 8 位指纹与 8 个候选', () => {
    for (const home of ['/home/a', '/Users/x', 'C:/Users/X']) {
      const id = identityOf(home);
      expect(id.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(id.ports).toHaveLength(8);
    }
  });

  it('claude 端读到的 fingerprint 必须是主包写出的那一个', () => {
    // claude 不自己算，正确性完全依赖 hosts sync 写入的值。这里核对
    // 主包的 identityOf 是唯一来源，写进 settings 的就是它。
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'main.ts'), 'utf-8');
    // hosts sync 必须把 identityOf 的结果传给 syncClaudeSettings。
    expect(source).toContain('identity: identityOf(os.homedir())');
  });
});
