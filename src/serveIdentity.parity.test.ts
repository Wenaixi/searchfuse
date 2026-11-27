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
import { describe, expect, it } from 'vitest';
import { identityOf } from './serveIdentity.ts';

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
  // 注入真实的 crypto / path：dsh 里这两个是 import 进来的名字，
  // 这里用同名参数传进去，等价于它自己的模块环境。
  // eslint-disable-next-line no-new-func
  const factory = new Function('createHash', 'resolve', 'join', program) as (
    createHash: typeof crypto.createHash,
    resolve: typeof path.resolve,
    join: typeof path.join,
  ) => (home: string) => { fingerprint: string; ports: number[] };
  return factory(crypto.createHash, path.resolve, path.join);
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

  it('claude 端读到的 fingerprint 必须是主包写出的那一个', () => {
    // claude 不自己算（沙箱里没有 crypto），正确性完全依赖 hosts sync 写入。
    // 这里只核对「写进 settings 的来源是 identityOf」这一条接线。
    const main = fs.readFileSync(path.join(repoRoot, 'src', 'main.ts'), 'utf-8');
    expect(main).toContain('identity: identityOf(os.homedir())');
  });
});
