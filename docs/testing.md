---
summary: '测试指南：Vitest 用法、就近布局、约定'
read_when:
  - 运行测试
  - 编写测试
  - 排查测试失败
---

# 测试指南

## 布局

测试与源码就近放置：每个模块旁边就有一个 `*.test.ts`（例如 `src/search.ts` 与 `src/search.test.ts`、`src/providers/tavily.ts` 与 `src/providers/tavily.test.ts`）。没有单独的 `test/` 目录。Vite 的库构建只从 `src/main.ts` 顺着导入图走，所以测试文件永远不会进 `dist/`。

## 命令

```bash
pnpm test                                   # 跑全部
pnpm exec vitest run src/xSource.test.ts    # 只跑一个文件
pnpm typecheck                              # tsc --noEmit，跑测试前先跑这个
```

## 约定

- 单元测试里不碰网络。HTTP 引擎（Tavily、Exa、Firecrawl、Keenable、AnySearch、You.com）靠打桩全局 `fetch` 来验，页面抓取跑在 `startLocalPage` 起的回环服务端上，`agy` 与 `grok` 两个子进程引擎换成回放固定信封的假 CLI。SearXNG 走随包实例，它的测试不真的起服务端。
- 要伪造家目录或 PATH（grok 可用性检查用得上），用 `src/testing/helpers.ts` 里的 `withTempHome` 与 `envWithBinaries`。它们会还原自己动过的东西。`withTempHome` 同时重定向 `HOME` 和 `USERPROFILE`，因为 `os.homedir()` 在 POSIX 上认 `HOME`、在 Windows 上认 `USERPROFILE`。
- 走子进程传输的引擎把 `buildInvocation` 与 `parseOutput` 当纯函数测，这在任何平台上都能跑。端到端的路由与回退测试要通过 `runSearch` 拉起一个假 CLI，而假 CLI 是 POSIX shell 脚本，所以那些套件挂在 `SPAWNS_FAKE_CLI` 上、在 Windows 上跳过。

## 平台覆盖

CI 在 `ubuntu-latest` 的 Node 22 / 24 / 26 与 `windows-latest` 的 Node 22 / 26 上跑 `pnpm typecheck && pnpm test && pnpm build`。少数只在 Unix 成立的套件被加了门，好让 Windows 那一格保持诚实而不是一路红：

- **拉起假 CLI**（`SPAWNS_FAKE_CLI`）。searchfuse 用 `spawn(bin, args)` 且不带 shell 地启动引擎，这是个刻意的安全选择。在 Windows 上只有真正的 `.exe` 才是可按路径执行的镜像：Node 拒绝在不加 `shell: true` 的情况下启动 `.cmd`/`.bat`（CVE-2024-27980），POSIX shell 脚本在那里也执行不了。要让假 CLI 跨平台就得有一个测试造不出来的真 `.exe`，所以拉起 `agy`/`grok` 假货的那几个套件只在 Unix 跑。进程内 HTTP 引擎以及全部纯路由、配置、解析逻辑仍然在 Windows 上跑。
- **SIGTERM/SIGKILL 逐级升级**（`src/subprocess.test.ts`）。这是 Unix 的信号语义：在 Windows 上 `child.kill` 总是调 `TerminateProcess`，没有可忽略的 SIGTERM 可供升级。
- **POSIX 权限位**（`expectPosixMode`）。Windows 用 ACL 而不是 rwx 位来表示文件访问，`stat.mode` 从不反映 `chmod`。那条断言在那里是空操作。
- **隐藏子进程控制台**（`src/spawnContract.test.ts`）。核心包与单独发布的 dsh 插件各自都只通过一个包装器启动子进程，它会在调用方选项之后写上 `windowsHide: true`。那条契约测试还会扫已发布的源码，一旦有别的文件伸手进 `child_process` 就失败，于是以后新加的 provider 没法悄悄把黑窗口闪一下带回到图形宿主上。

- 真实调用 `agy` / `grok` 属于端到端验证，不是单元测试。它们会真花额度，所以别放进 `pnpm test`。

## 证明一条测试能失败

没亲眼见过它变红，一条绿测试什么也没证明。两个便宜的习惯能抓住大多数情况：

- **改实现，别改测试。** 打断这条测试本该覆盖的那一行，跑一遍，确认它失败。在变异下仍然绿的测试只是装饰。之后把变异还原，再跑一遍确认转绿。
- **断言落在错误实现产生不出来的量上。** 取消这种事上，断言"抛错了"很弱：超时也抛错。改断言耗时——5 秒超时配 50 毫秒中止，2 秒内结束只可能来自那次中止。缓存与重载逻辑则断言调用次数，而不是返回值。

比真实系统能力更弱的测试替身，会悄悄跳过整条路径。`src/dshPlugin.test.ts` 里的 `house()` 夹具之所以让 `tools.register` 返回一个撤销函数，正是这个理由：不这么做，"先撤掉旧一代、再注册新一代"那条路径永远不会跑，而热重载测试会对一个从不撤销任何东西的实现照样绿。当替身模拟不了生产代码依赖的某个行为时，去扩展替身，而不是把断言放宽。

## 假绿的四种形态

上面那条习惯说来容易，做起来会连着被骗。2026-11-25 审查本地服务生命周期时补了十余条测试，每一条都反向验证过（破坏实现、看它是否变红），抓到四种假绿。它们都**看起来**像在守护什么。

### 一、测的是原生 API，不是我们的代码

```ts
expect(() => fs.openSync(lock, 'wx')).toThrow(/EEXIST/);
```

它测的是 Node 的 `wx` 语义。把生产实现退回有缺陷的 `mkdirSync(recursive: true)` 后**照样绿**——那条断言压根没碰我们的代码。

判据：这条断言里有没有**生产代码的符号**？没有就是假的。

### 二、抄一份生产判据到本地去测

```ts
function codeMeansAlive(error) { return error.code === 'EPERM'; }  // 抄的副本
expect(codeMeansAlive(err)).toBe(true);
```

测的是那份副本。破坏生产实现后照样绿。

判据：**断言必须走进 function under test**。生产函数 import 不进来，就把它抽成独立模块再导入，不要抄。`src/util/isAlive.ts` 就是这么从 `src/main.ts` 里抽出来的——`main.ts` 顶层有 `await program.parseAsync`，导入它会把整条 CLI 解析跑一遍。

### 三、异步窗口没等到就断言

「早退时不该 spawn 子进程」→ 断言 `fs.existsSync(marker) === false`。但 `spawn` 是异步的，`detached` 的子进程要过几毫秒才写标记。**立刻检查永远是 false**，于是把早退段删掉测试也绿。

判据：断言否定性事实（「不该发生」）时，必须先给「如果会发生」留足时间窗口，再断言它没发生。

### 四、黑盒并发测试掩盖竞态

起两个真实 `serve --ensure` 数存活进程，看起来是最像真事的验证。实测：破坏锁实现后它**照样绿**——两个进程启动有先后，第二个读到已经写出的 `runtime.json` 就走「Already running」早退，把竞态盖住了。而且它要跑 20 秒，还容易在测试被强杀时泄漏进程和锁。

结论：能稳定自动化的只有纯函数判据。锁的其余行为（`linkSync` 的内核原子性、陈旧回收、立即释放）靠代码审查与项目 `CLAUDE.md` 的事故记录兜底，这是有意识的取舍，不是漏测。注意那三种行为里，能真跑并发验的只有 `isAlive` 的 EPERM 判据（`src/serveEnsure.test.ts` 里那条直接测生产函数）；`linkSync` 本身的原子性虽然做过 8 进程实测（`openSync('wx')` 版 8/8 全部误报持锁，`linkSync` 版恰好 1 个成功、7 个 EEXIST），但那是一次性的人工验证，没有进测试套件。

## 热重载

插件自己拥有 `~/.searchfuse/config.json`，它在宿主的 profile 之外，所以宿主的重载信号永远不会为它触发。`watchModsearchConfigFile` 每隔几秒 stat 一次它的 mtime，MCP 工具与引擎工具都挂在这唯一一个监视器上——只有一个定时器，因为对同一个文件挂两套监视器会让两半在一次保存之后短暂地看法不一致。

每个重载器各带自己的签名，没变就跳过。引擎工具的签名只覆盖决定**某个工具存不存在**的那几项：原始名、引擎、启用状态、自定义工具名。API 密钥、代理、base URL 被刻意排除在外，于是轮换一把密钥不会让工具从用户正看着的那个列表里闪一下消失又出现。

测试用 `vi.useFakeTimers()` 和 `advanceTimersByTimeAsync` 驱动它，这要求轮询间隔保持是一个普通的 `setInterval`，而不是 `await new Promise(setTimeout)`。
