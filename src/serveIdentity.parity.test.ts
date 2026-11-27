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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { identityOf } from './serveIdentity.ts';

const { createHash } = crypto;

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

  it('dsh 的取模数与主包相同（这是最容易漂移的一处）', () => {
    // 早先这里只测了 base 与 span，漏掉了取模数。2000 是窄带宽度，决定
    // 端口落在哪个位置；两端写成不同的数（例如 2001）会得到完全不同的
    // 候选，而 base/span 的断言照样全绿——正是最难查的一类故障。
    //
    // 注意源码里写的是 `2_000`（数字分隔符），比较时要先去掉下划线，
    // 否则 `(\d+)` 只能抓到开头的 `2`。
    const numeric = (text: string, pattern: RegExp, what: string): number => {
      const match = text.match(pattern);
      if (match === null) throw new Error(`找不到 ${what}`);
      return Number(match[1]!.replace(/_/g, ''));
    };
    const dsh = fs.readFileSync(path.join(repoRoot, 'dsh', 'index.ts'), 'utf-8');
    const main = fs.readFileSync(path.join(repoRoot, 'src', 'serveIdentity.ts'), 'utf-8');
    const dshMod = numeric(dsh, /seed % ([0-9_]+)/, 'dsh 的取模数');
    const mainMod = numeric(main, /seed % ([0-9_]+)/, '主包的取模数');
    expect(dshMod).toBe(mainMod);
    expect(dshMod).toBe(2_000);
  });

  it('两端对同一目录算出同一组端口（不只是常量相同）', () => {
    // 常量一致不代表输出一致：取模、截断、大小写任何一处写错，常量都对
    // 而结果不同。这里按两侧各自的常量与算法实际算一遍再比对。
    const dsh = fs.readFileSync(path.join(repoRoot, 'dsh', 'index.ts'), 'utf-8');
    const numeric = (text: string, pattern: RegExp, what: string): number => {
      const match = text.match(pattern);
      if (match === null) throw new Error(`找不到 ${what}`);
      return Number(match[1]!.replace(/_/g, ''));
    };
    const base = numeric(dsh, /IDENTITY_PORT_BASE = ([0-9_]+)/, 'base');
    const span = numeric(dsh, /IDENTITY_PORT_SPAN = ([0-9_]+)/, 'span');
    const mod = numeric(dsh, /seed % ([0-9_]+)/, 'mod');
    const slice = numeric(dsh, /digest\('hex'\)\.slice\(0, ([0-9]+)\)/, 'slice');

    const fingerprintOf = (dir: string): string =>
      createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, slice);
    const portsOf = (fp: string): number[] => {
      const seed = Number.parseInt(fp, 16);
      const from = base + (seed % mod);
      return Array.from({ length: span }, (_, i) => from + i);
    };

    for (const home of ['/home/a', 'C:/Users/Administrator', '/tmp/x', '/home/中文', '/a']) {
      const dir = path.join(home, '.searchfuse');
      const dshFp = fingerprintOf(dir);
      const dshPorts = portsOf(dshFp);
      // 主包是唯一真相源：它的输出必须与 dsh 侧算出的完全相同。
      const main = identityOf(home);
      expect(dshFp).toBe(main.fingerprint);
      expect(dshPorts).toEqual(main.ports);
    }
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
