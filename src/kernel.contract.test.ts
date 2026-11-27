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

/** 跑一次 kernel，返回退出码、合并后的输出与墙钟耗时。 */
function runKernel(args: string[]): { code: number | null; output: string; ms: number } {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [kernel, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, MODSEARCH_NESTED: '' },
  });
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    ms: Date.now() - startedAt,
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
    //
    // 早先只断言「不是 2」，但坏行为是**退 0 并真的去搜**，它满足「不是 2」。
    // 现在同时钉住「不是 0」与措辞，否则这条测试对 `-e` 被忽略那个缺陷
    // 毫无守护力。
    const { code, output } = runKernel(['-q', 'x', '-e', '__no-such-engine__']);
    expect(code).toBe(1);
    expect(output).toMatch(/Unknown engine/);
  }, 30_000);

  it('短选项 -e 会被解析，无效引擎当场报错而不是静默去搜', () => {
    // 这一条守的是 takeOption 的别名表：早先 kernel 只把 `--engine` 传进去，
    // `-e` 被整个跳过 —— `engine` 变成 undefined，于是回退成一次全引擎融合，
    // 退出码 0、真的花掉几十秒额度。断言必须同时钉住「该报错」的措辞、
    // 「不该退 0」，以及「没有真的去搜」。
    //
    // 光有措辞断言不够：构造一个「stderr 里塞一句 Unknown engine、然后照样
    // 回退去搜」的实现，前面两条断言都会满足。区分「报了错就停」与「报了错
    // 还在搜」的可靠判据是墙钟耗时 —— 前者只走解析，1-2 秒；真去搜要 6 秒以上。
    const { code, output, ms } = runKernel(['-q', 'x', '-e', '__no-such-engine__']);
    expect(code).not.toBe(0);
    expect(output).toMatch(/Unknown engine/);
    expect(output).toMatch(/__no-such-engine__/);
    expect(ms).toBeLessThan(6000);
  }, 30_000);

  it('短选项 -u 与 --url 等价，否则 dsh 的 read_page 一律退 2', () => {
    // dsh 侧的 read_page 传的正是 `-u`。早先这里只认 `--url`，于是
    // `-u <url>` 被判成「什么也没给」，退 2 —— 工具注册成功、调用必败。
    // 期望退 1（引擎层失败，说明参数已通过），与 `--url` 那条同判据。
    const { code } = runKernel(['-u', 'http://127.0.0.1:9/nope', '--timeout', '3000']);
    expect(code).toBe(1);
  }, 30_000);

  it('选项缺值时不当成「值是一个选项」，也不静默去搜', () => {
    // `--engine -q x` 里的 `-q` 是选项、不是引擎名。早先的判断只拦 `--`
    // 开头的词，`-q` 会被当成引擎名 → 报错；而更早的版本干脆整个跳过。
    // 这里钉住「缺值要被识别出来」，不是把下一个选项吞成值。
    const { output } = runKernel(['-q', 'x', '-e', '--timeout', '3000']);
    // 要么明确报缺值，要么报未知引擎 —— 但绝不能把 `--timeout` 当引擎名。
    expect(output).not.toMatch(/engine: *--timeout/);
    expect(output).not.toMatch(/--timeout: *Unknown engine/);
  }, 30_000);

  it('短选项 -s 与 --source 等价：用有效引擎时才看得见差异', () => {
    // 这条早先写成 `-s x -e __no-such-engine__`，于是 `-s` 被忽略后错误照样
    // 由 `-e` 抛出，两条路输出逐字节相同 —— 是个假绿。要看见 `-s` 的作用，
    // 必须让引擎有效、让「搜哪个语料」决定结果：X 语料在本机不可达（没有
    // Grok 登录态），会给出 unavailable + 明确的 warnings；web 则正常搜索。
    const short = runKernel(['-q', 'x', '-s', 'x', '--timeout', '3000']);
    const long = runKernel(['-q', 'x', '--source', 'x', '--timeout', '3000']);
    // 两种写法必须得到同样的一类结论（要么都退 1，要么都退 0），
    // 而不是一个去搜 X、另一个去搜 web。
    expect(short.code).toBe(long.code);
    expect(short.output).not.toMatch(/nothing to do/);
    expect(long.output).not.toMatch(/nothing to do/);
  }, 60_000);

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
