// kernel 的入口契约。
//
// 为什么这一组必须先于任何宿主级验证存在：kernel 是三宿主共用的子进程
// 入口，Claude 与 omp 两边的 `read_page` 都只传 `--url`。入口校验一旦
// 要求非空 `--query`，那两处的 read_page 就「注册成功、调用必败」，而
// 报错还指向参数问题，看起来像是调用方写错了，不像是入口不支持。
//
// 判定方式：跑真实的 `dist/kernel.js` 子进程，只看**退出码**。
// 0 = 有结果，1 = 引擎失败（说明参数已通过），2 = 参数错误。
// 刻意用一个必然被引擎拒绝的私网地址，这样断言不依赖外网、不花额度、
// 也不会因为某天某个引擎挂了而变成假红。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kernel = path.join(root, 'dist', 'kernel.js');

/** 跑一次 kernel，返回退出码与合并后的输出。 */
function runKernel(args: string[]): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [kernel, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, MODSEARCH_NESTED: '' },
  });
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('kernel 的入口契约', () => {
  // Windows 上起一次真实 Node 子进程要 1-3 秒，默认 5 秒超时会在冷启动时
  // 假红。这里的断言都只看退出码，等得起。
  const SPAWN_TIMEOUT = 30_000;

  it('构建产物存在，否则整组断言都失去意义', () => {
    expect(fs.existsSync(kernel)).toBe(true);
  });

  it('两个参数全缺时退 2，并点名两个选项', () => {
    const { code, output } = runKernel([]);
    expect(code).toBe(2);
    expect(output).toMatch(/--query|--url/);
  }, SPAWN_TIMEOUT);

  it('只给 --url 就进入抓页路径，不再要求 --query', () => {
    // 私网地址会被引擎拒绝，所以期望退 1（引擎层失败）而不是 2（参数错误）。
    // 这一条就是 read_page 在 Claude/omp 两侧能不能活的分界线。
    const { code } = runKernel(['--url', 'http://127.0.0.1:9/nope', '--timeout', '3000']);
    expect(code).toBe(1);
  }, 30_000);

  it('只给 -q 就放行，不被入口拦下', () => {
    // 不走真实搜索：那会花掉引擎额度、还受缓存影响。这里只用一只
    // 不存在的引擎，让入口先放行、再由引擎层立刻报错。
    // 关键看「不是 2」——2 表示入口把 -q 判成了参数错误。
    const { code } = runKernel(['-q', 'x', '-e', '__no-such-engine__']);
    expect(code).not.toBe(2);
  }, 30_000);

  it('--url 与 -q 同时给时按抓页处理，-q 当关注点', () => {
    // 引擎全失败时 kernel 只往 stderr 写原因、stdout 为空（这是既有契约），
    // 所以判据只能是 stderr 的措辞：抓页失败会点名 fetch 那条链路，
    // 搜索失败会点名 web source。拿 -q 去搜的坏版本会走后者。
    const { code, output } = runKernel([
      '--url',
      'http://127.0.0.1:9/nope',
      '-q',
      'anything',
      '--timeout',
      '3000',
    ]);
    expect(code).toBe(1);
    // 私网拦截只会出现在抓页分支上，搜索分支不会报这个。
    expect(output).toMatch(/private|reserved|127\.0\.0\.1/);
  }, 30_000);

  it('非正的数值参数仍然退 2', () => {
    const { code } = runKernel(['-q', 'x', '--timeout', '0']);
    expect(code).toBe(2);
  }, SPAWN_TIMEOUT);
});
