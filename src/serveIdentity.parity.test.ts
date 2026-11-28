// 三端身份推导的一致性守护。
//
// 服务身份算法有三份拷贝：
// - `src/serveIdentity.ts`（主包：CLI、serveEnsure 都用它）
// - `dsh/index.ts`（dsh 独立构建，rootDir="dsh"，不能 import src）
// - `claude/hooks/register.ts`（mod 沙箱连 crypto 都没有，只读 CLI 写好的值）
//
// 任何一份漂移，都会造成「服务绑一个端口、客户端去探另一个」的错配，症状与
// 「服务没起来」一模一样——最难查的一类故障。
//
// **早先这里只从 dsh 源码里抓几个数字然后自己重建算法**。那样有个致命盲区：
// 常量对得上，但归一化（`.toLowerCase()`）、取模、截断任一实现细节漂移时，
// 抓出来的数字照样对，重建出的端口照样对，全量测试一条不红。实测：把 dsh 的
// `.toLowerCase()` 删掉，838 条测试零红。
//
// 现在改成**抽取 dsh 的真实函数体、在真实模块环境里求值**，再与主包的
// `identityOf` 逐组比对。这样任何实现细节漂移都会当场暴露。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { identityOf } from './serveIdentity.ts';
import { cleanupTempDirs, tempDir } from './testing/helpers.ts';

afterEach(() => {
  cleanupTempDirs();
});

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const dshSource = fs.readFileSync(path.join(repoRoot, 'dsh', 'index.ts'), 'utf-8');

/**
 * 把 TypeScript 的类型标注剥成可被 `new Function` 执行的 JS。
 *
 * dsh 的源码是 TS，`new Function` 只认 JS。要剥的只有三类：冒号后面的类型、
 * `as` 断言、`declare` 之类。这里不做通用转译，只处理这一小段源码里出现的
 * 形状——覆盖面窄是刻意的，宁可剥离失败（抛错）也不要悄悄剥错。
 */
function stripTypes(source: string): string {
  return (
    source
      // 函数参数与返回值标注：`: number[]` / `: string` / `: { ... }`
      .replace(/:\s*number\[\]/g, '')
      .replace(/:\s*string/g, '')
      .replace(/:\s*(?:number|boolean)/g, '')
      .replace(/\)\s*:\s*\{[^}]*\}/g, ')')
      // 变量声明的标注：`const ports: number[] =`
      .replace(/(const|let)\s+(\w+)\s*:\s*[^=;]+=/g, '$1 $2 =')
      // as 断言
      .replace(/\s+as\s+\w+/g, '')
  );
}
function evalDshIdentity(): (home: string) => { fingerprint: string; ports: number[] } {
  // 取常量与三个函数声明。用非贪婪匹配到下一个顶层声明的边界。
  const grab = (pattern: RegExp, what: string): string => {
    const match = dshSource.match(pattern);
    if (match === null) throw new Error(`dsh/index.ts 里找不到 ${what}——声明被改名或删掉了`);
    return match[0];
  };

  const baseDecl = grab(/const IDENTITY_PORT_BASE = [0-9_]+;/, 'IDENTITY_PORT_BASE');
  const spanDecl = grab(/const IDENTITY_PORT_SPAN = [0-9_]+;/, 'IDENTITY_PORT_SPAN');
  // 三个函数体：从 `function xxx(` 到配对的收尾 `}`。
  const fpFn = grab(/function identityFingerprintOf[\s\S]*?\n}/, 'identityFingerprintOf');
  const portsFn = grab(/function identityCandidatePorts[\s\S]*?\n}/, 'identityCandidatePorts');
  const ofHomeFn = grab(/function identityOfHome[\s\S]*?\n}/, 'identityOfHome');

  const program = stripTypes(`
${baseDecl}
${spanDecl}
${fpFn}
${portsFn}
${ofHomeFn}
return identityOfHome;
`);
  // 注入 dsh 模块环境里真实存在的四个名字。**`realpathSync` 不能漏**：
  // 漏了它，`realpathSync(stateDir)` 抛 TypeError 被 catch 吞掉，全部用例都
  // 走 `resolve` 那条降级分支，于是这份 parity 测试对真实的 realpath 归一化
  // （junction 与目标算同一份、8.3 短名不展平）**零守护力**——测试绿的原因
  // 不是"两份一致"，而是"两边都没跑那条分支"。
  // eslint-disable-next-line no-new-func
  const factory = new Function('createHash', 'realpathSync', 'resolve', 'join', program) as (
    createHash: typeof crypto.createHash,
    realpathSync: typeof fs.realpathSync,
    resolve: typeof path.resolve,
    join: typeof path.join,
  ) => (home: string) => { fingerprint: string; ports: number[] };
  return factory(crypto.createHash, fs.realpathSync, path.resolve, path.join);
}

const ompSource = fs.readFileSync(path.join(repoRoot, 'omp', 'extension.ts'), 'utf-8');

/**
 * 抽取 omp 扩展里的同一套算法求值。
 *
 * omp 与 dsh 的差别只有一处：它用 `realpathSync` 做归一化（与主包一致），
 * 而 dsh 那两份同样有 realpathSync——所以注入表多一个 `realpathSync`。
 */
function evalOmpIdentity(): (home: string) => { fingerprint: string; ports: number[] } {
  const grab = (pattern: RegExp, what: string): string => {
    const match = ompSource.match(pattern);
    if (match === null) throw new Error(`omp/extension.ts 里找不到 ${what}——声明被改名或删掉了`);
    return match[0];
  };

  const baseDecl = grab(/const IDENTITY_PORT_BASE = [0-9_]+;/, 'IDENTITY_PORT_BASE');
  const spanDecl = grab(/const IDENTITY_PORT_SPAN = [0-9_]+;/, 'IDENTITY_PORT_SPAN');
  const fpFn = grab(/function identityFingerprintOf[\s\S]*?\n}/, 'identityFingerprintOf');
  const portsFn = grab(/function identityCandidatePorts[\s\S]*?\n}/, 'identityCandidatePorts');
  const ofHomeFn = grab(/function identityOfHome[\s\S]*?\n}/, 'identityOfHome');

  const program = stripTypes(`
${baseDecl}
${spanDecl}
${fpFn}
${portsFn}
${ofHomeFn}
return identityOfHome;
`);
  // eslint-disable-next-line no-new-func
  const factory = new Function('createHash', 'realpathSync', 'resolve', 'join', program) as (
    createHash: typeof crypto.createHash,
    realpathSync: typeof fs.realpathSync,
    resolve: typeof path.resolve,
    join: typeof path.join,
  ) => (home: string) => { fingerprint: string; ports: number[] };
  return factory(crypto.createHash, fs.realpathSync, path.resolve, path.join);
}

describe('三端的身份推导必须一致', () => {
  const cases = [
    '/home/a',
    '/home/b',
    '/Users/x',
    'C:/Users/Administrator',
    '/tmp/x',
    '/home/中文',
    '/root',
    '/a',
    '/zz',
  ];

  it('dsh 的真实实现与主包对同一目录给出同一组结果', () => {
    // 这是本文件的核心断言。dsh 的函数体被原样抽出来求值，所以：
    // - 取模数漂移 → base 不同 → 端口不同 → 红
    // - 归一化少写 .toLowerCase() → 大小写目录的指纹不同 → 红
    // - 截断长度漂移 → 指纹不同 → 红
    // - 候选数量漂移 → 数组长度不同 → 红
    const dshIdentityOf = evalDshIdentity();
    for (const home of cases) {
      const fromDsh = dshIdentityOf(home);
      // 主包用它的 stateDirOf（join(home, '.searchfuse')），dsh 也是 join，
      // 所以两者对同一个 home 的输入路径完全相同。
      const fromMain = identityOf(home);
      expect(fromDsh.fingerprint, `指纹不同：${home}`).toBe(fromMain.fingerprint);
      expect(fromDsh.ports, `候选端口不同：${home}`).toEqual(fromMain.ports);
    }
  });

  it('大小写不同的同一目录必须归一化到同一组结果', () => {
    // 单独钉住归一化这一步：Windows 上 C:\Users 与 c:\users 是同一个目录。
    // 只要 dsh 那边少写一个 .toLowerCase()，这条就会红。
    const dshIdentityOf = evalDshIdentity();
    const upper = dshIdentityOf('C:/Users/Administrator');
    const lower = dshIdentityOf('c:/users/administrator');
    expect(upper.fingerprint).toBe(lower.fingerprint);
    expect(upper.ports).toEqual(lower.ports);
    // 主包同样如此。
    expect(identityOf('C:/Users/Administrator').fingerprint).toBe(
      identityOf('c:/users/administrator').fingerprint,
    );
  });

  it('对真实存在的目录，三份实现都走 realpath 分支且结果一致', () => {
    // **上面所有用例的路径都不存在**，于是三份实现全都靠 `catch` 退回
    // `resolve`，realpath 这条真正决定生产行为的分支从未被执行过。
    // 这条用一个真实存在的临时目录，把那条分支拉进射程。
    //
    // 为什么重要：junction / 符号链接与它的目标必须是同一份状态（台账记的
    // dsh profile 快照问题就是这个形态）；8.3 短名不被 realpathSync 展平，
    // 也是已知限制。这两条都只在 realpath 分支里成立。
    const dir = tempDir('identity-parity-');
    fs.mkdirSync(path.join(dir, '.searchfuse'), { recursive: true });

    const dshIdentityOf = evalDshIdentity();
    const ompIdentityOf = evalOmpIdentity();

    const fromMain = identityOf(dir);
    expect(dshIdentityOf(dir)).toEqual(fromMain);
    expect(ompIdentityOf(dir)).toEqual(fromMain);

    // **把 realpath 与 resolve 分开的关键一步。** 上面四条用例的路径都不存在，
    // 三份实现全走 `catch → resolve`；而即使目录存在但没有链接，realpath 与
    // resolve 也给出同一串。所以只测「存在」还锁不住这条分支——实测：把
    // realpathSync 从求值器里去掉，7 条全绿。
    //
    // 建一个指向真实目录的 junction，让两条路径给出**不同**的字符串：
    // realpath(link) → <target>，resolve(link) → <link>。三份实现必须都返回
    // target 的指纹；任何一份退回 resolve，指纹就会不同，立刻变红。
    const target = path.join(dir, 'target-home');
    const link = path.join(dir, 'linked-home');
    fs.mkdirSync(path.join(target, '.searchfuse'), { recursive: true });
    fs.symlinkSync(target, link, 'junction');

    // 断言前提成立：两条路径确实不同，否则下面比不出东西。
    expect(fs.realpathSync(link)).not.toBe(path.resolve(link));

    const viaLinkMain = identityOf(link);
    expect(viaLinkMain.fingerprint).toBe(identityOf(target).fingerprint);
    expect(dshIdentityOf(link).fingerprint).toBe(identityOf(target).fingerprint);
    expect(ompIdentityOf(link).fingerprint).toBe(identityOf(target).fingerprint);
  });

  it('dsh 的指纹是 8 位十六进制，与主包一致', () => {
    const dshIdentityOf = evalDshIdentity();
    for (const home of cases) {
      const fp = dshIdentityOf(home).fingerprint;
      expect(fp).toMatch(/^[0-9a-f]{8}$/);
      expect(fp).toBe(identityOf(home).fingerprint);
    }
  });

  it('候选端口落在预期窄带内且连续（锁定 base 与 span 的语义）', () => {
    // 固定一个目录钉死具体端口值：这比「>= 42000 && < 44000」严得多，
    // 任何取模宽度的漂移都会改变这个值。
    const dshIdentityOf = evalDshIdentity();
    for (const home of cases) {
      const ports = dshIdentityOf(home).ports;
      expect(ports).toHaveLength(8);
      expect(ports[0]).toBeGreaterThanOrEqual(42_000);
      expect(ports[0]).toBeLessThan(44_000);
      for (let i = 1; i < ports.length; i += 1) {
        expect(ports[i]).toBe(ports[i - 1]! + 1);
      }
      expect(ports).toEqual(identityOf(home).ports);
    }
  });

  it('omp 扩展的真实实现与主包对同一目录给出同一组结果', () => {
    // omp 是第三份拷贝（见 omp/extension.ts 顶部注释）。它同样被原样抽取
    // 求值，所以任何实现细节漂移都会当场暴露。
    const ompIdentityOf = evalOmpIdentity();
    for (const home of cases) {
      const fromOmp = ompIdentityOf(home);
      const fromMain = identityOf(home);
      expect(fromOmp.fingerprint, `指纹不同：${home}`).toBe(fromMain.fingerprint);
      expect(fromOmp.ports, `候选端口不同：${home}`).toEqual(fromMain.ports);
    }
  });

  it('claude 端读到的 fingerprint 必须是主包写出的那一个', () => {
    // claude 不自己算（沙箱里没有 crypto），正确性完全依赖 hosts sync 写入。
    // 这里只核对「写进 settings 的来源是 identityOf」这一条接线。
    const main = fs.readFileSync(path.join(repoRoot, 'src', 'main.ts'), 'utf-8');
    expect(main).toContain('identity: identityOf(os.homedir())');
  });
});
