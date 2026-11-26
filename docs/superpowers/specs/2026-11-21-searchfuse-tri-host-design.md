# searchfuse 三宿主架构设计（dsh + Claude Code + omp）

> 状态：已实施。本文档是当时的**设计决策记录**，不是现状说明；实现如果已经演进，以代码为准。
> 日期：2026-11-21（v7，经六轮 Architect + Critic 评审）
> 仓库：`E:\newCC\aaa-dsh-go\searchfuse`（`@wenaixi/searchfuse`）
> 取代：`2026-11-20-searchfuse-dual-host-design.md`

## 〇、修订摘要（三轮评审）

v2 经第二轮 Architect 复审裁决 **CONDITIONAL**；v3 经第三轮 Critic 复审裁决 **REVISE**（五条阻塞项）。本节记录全部修正，第三轮的用 `V4-*` 标注。

### v7 修正（第六轮终审的 8 条放行条件）

| # | v6 的缺陷 | v7 处置 |
|---|---|---|
| V7-1 | S3① 断言 `attempts` 非空，但 `rrf` 路径硬编码 `attempts: []`（`src/search.ts:479`、`:511`），默认配置即 `rrf` → 验收恒红 | 改为「`--engine` 钉死链式或 `aggregate.mode: chain` 时断言」 |
| V7-2 | v6 重排 §5.1 时删掉了 `runtime.json` 的定义，S1⑦ 断言一个无产者的产物 | 恢复定义：`~/.searchfuse/runtime.json`，由 `src/serve/lifecycle.ts` 写入/删除 |
| V7-3 | `servePath` / `--ensure` 全文无定义；扩展「裸复制」后无法定位 `dist/serve.js` | 改为**渲染**：`hosts sync` 把绝对路径替换进模板；§十二 增加 `serve --ensure`（幂等拉起） |
| V7-4 | §5.1 镜像写入未约束「只改一个键」，与 §6.3 的粒度要求不对称 | 明写「解析→改键→回写，禁止整份覆盖」；omp enable 分支补 `searxng.token` 写入 |
| V7-5 | S4⑤ 的 `hosts sync --disable` 与 §十二 的三动词对不上 | 改为 `hosts enable/disable <name> && hosts sync` |
| V7-6 | §十七 仍写「9 同 9 异 4 独有」；Follow-ups 仍用「服务日志」；§十二 说 entry「两项」 | 逐个改正（3 独有 / `/__stats` / 三项含 `config-schema`） |
| V7-7 | omp 示例的 `type(...)` 是裸符号（真实是 `pi.zod`/`pi.typebox`/`pi.arktype`）；`execute` 参数顺序错 | 改为 `pi.zod.object(...)` + `execute(toolCallId, params)` |
| V7-8 | `localHits` 未定义存活期 → 跨进程时 S5② 仍有假绿通道 | 定义为进程内计数、不落盘；S5② 的 baseline 与复测必须同一进程 |

### v6 修正（第五轮终审的 3 条放行条件）

| # | v5 的缺陷（终审指出，已实测复核） | v6 处置 |
|---|---|---|
| V6-1 | `searchfuseHosts` **只有读、没有写**；`hosts sync` 职责清单无此项 → hook 恒读 `undefined`，S4 静默失效 | §5.1 sync 职责加镜像写入；§4.3 改为「CLI 镜像一个键」；S4⑤ 验收 |
| V6-2 | §十四 e2e 仍用 `--strict`，与 S4① 及 V5-2 互斥 | 改为不加 `--strict` + 断言 `Validating hooks` |
| V6-3 | 端点表漏 `/__stats`；`/healthz` 与「全部端点校验 Bearer」冲突 | 端点表补列与鉴权列；`localHits` 定义口径；`/healthz` 免鉴权 |
| V6-4 | omp 扩展 API 照抄了 Claude Code 的 `$` DSL（真实是 `pi.on('session_start')` + `node:child_process`） | §6.3 给出真实签名与依据 |
| V6-5 | `serve-token` 轮换后 omp 无人更新 → 重启即静默回公网 | §5.2 补信号机制 |
| V6-6 | §三 的 `claude/types/register.d.ts` 与「零类型导入」互斥 | 删除该行 |
| V6-7 | 「4 个独有」不成立，`timedRequest.ts` 有分叉对应物 | 改为 9 同 / 10 分叉 / 3 独有 |

### v5 修正（第四轮评审的 10 条放行条件）

| # | v4 的缺陷（第四轮评审指出，已实测复核） | v5 处置 |
|---|---|---|
| V5-1 | §6.3 第 365 行与第 389 行对 `enabled=false` 互斥（改 vs 不改） | 统一为**主动改写**；S5④ 补 disable 三断言 |
| V5-2 | S4① 用 `validate --strict` 是假绿（空目录也 exit 0），且 `--strict` 被 README/LICENSE/icon 干扰 | 改为**不加 `--strict`** + 断言 stdout 含 `Validating hooks` 与 `calls:` |
| V5-3 | §6.2 示例过不了 S4①（`TS7006` ×4、`TS2591`） | 示例全部标 `: any`，`process` 改 `(globalThis as any).process`，**已实测通过** |
| V5-4 | S5①/② 依赖不存在的「服务日志」 | 新增 `GET /__stats` 返回 `{ localHits }`，列入 S1⑥；S5② 改三条件 |
| V5-5 | `dsh/index.js` 够不到 TS 源码，共用白名单无落点 | 新增 `src/config-schema.ts` → `dist/config-schema.js` entry，S2④ 验收 |
| V5-6 | Claude Code 开关三套机制打架 | 统一 `$.settings.read({key:'searchfuseHosts'})`；`plugin.json` 的 `userConfig` **作废删除** |
| V5-7 | kernel I/O 契约未定义（dsh 传 `-q`，Claude 传 `--query`） | §三 写死 argv/stdout/退出码；kernel 同时接受 `-q` 与 `--query` |
| V5-8 | `omp/` 不建但 §5.1 依赖扩展拉起服务 | **建 `omp/extension.ts`**，由 `hosts sync` 装到 `~/.omp/agent/extensions/` |
| V5-9 | §十五「omp 报明确诊断」与实测冲突；§十六顺序矛盾；§十三数错；§十一文件数 | 逐条改正 |
| V5-10 | spec 未提交 git，评审期间被改，无法复现 | **提交并给出 commit hash** |

### v4 修正（第三轮评审的五条阻塞项）

| # | v3 的缺陷（第三轮评审指出，已实测复核） | v4 处置 |
|---|---|---|
| V4-1 | **没有人启动服务**：只有手动 `serve`，而空闲 300 秒自动退出 → omp 5 分钟后必然静默走公网 | §5.1 补三条启动路径；`idleExitSeconds` 默认改为 **0（不退出）** |
| V4-2 | S5 第二句「服务停掉后 omp 给出诊断」是错的：实测 omp **静默走公网、exit 0、stderr 空** | §6.3 统一为「回退存在，但目标是公网」；S5② 改为断言「本地计数为 0」 |
| V4-3 | §6.2 同节两种互斥传输（spawn kernel vs curl HTTP）；示例代码通不过 `validate` | 统一为 **只 spawn kernel**；示例按 `validate` 硬规则重写 |
| V4-4 | T13 要把测试迁到不存在的 `test/`，且被测对象随 T9 一起被删 | 改为**整目录删除**；`src/util/timedRequest.test.ts`（191 行）已覆盖同一语义 |
| V4-5 | S7 要求 `npm pack` 含 `omp/` 与根级 `hooks/hooks.json`，两者都不存在 | `omp/` **不建**；路径改为 `claude/hooks/hooks.json` |
| V4-6 | `claude plugin validate` 这个零成本红测试从未被使用 | §6.2 记录其三类实测能力；**S4① 改为 `validate --strict` 退出码 0** |
| V4-7 | `claude plugin test` 失败时仍 exit 0（实测 0 pass/1 fail → exit 0） | §6.2 明确「不可作为门槛」；§十四 e2e 删掉「`plugin test` 绿」 |
| V4-8 | T-R1 的「`providers.webSearch` 是旧键」未获实测支持 | 改为「两者行为一致，选 `modelRoles.web` 是为同处声明回退」 |
| V4-9 | `hosts.omp.enabled=false` 无生效机制 | `hosts sync` 主动写回 `web/public` 并清空 endpoint；S5③ 验收 |

### v3 修正（第二轮评审）

| # | v2 的缺陷（第二轮评审指出，已复核） | v3 处置 |
|---|---|---|
| T1 | §十 S4① 用 `claude plugin test` 当验收，但**它从不执行 hooks 模块**。实测：`register.ts` 写 `throw new Error("BOOM")`，`claude plugin test` 仍 exit 0 | 改为「真实触发 `tool.call` 的链路」+ 插件内禁 `vitest` |
| T2 | §三 的「diff 为空」是循环论证：产物只由该生成器产出，重建必然为空 | 改为「生成清单双向断言：清单内每个文件都存在，清单外零文件」 |
| T3 | §四 `undici` 禁令未提，而 `src/providers/httpFetch.ts:12` 与 `src/util/timedRequest.ts:1` 都 `import { … } from 'undici'`。hooks 加载器只允许相对路径与 `claude-code` | §三 补 `undici` 在内的「零非法 import」断言 |
| T4 | §6.2 的 `import type { Register } from 'claude-code'` 实测 TS2307；全局安装**不存在** `.claude-plugin/types/` | 改为从 `sdk-tools.d.ts` 附近自建 `.d.ts`，或运行时零类型依赖 |
| T5 | §5.3 的 dsh「in-process」是虚构：`dsh/index.js:225` 起子进程，`dist/main.js` **零 export** | 新增 `dist/kernel.js` 导出 `runSearch`，列为 S3 前置 |
| T6 | §十 S4③ 的 `.catch` 两分支同表达式，是死代码 | 改为行为测试：「hook 抛错时 `next` 被调用恰好一次」 |
| T7 | §4.2 与 §5.2 把 `serve.token` 声明在两个真身（`config.json` 与 `serve-token` 文件） | 只留 `~/.searchfuse/serve-token`，`config.json` 不存秘密 |
| T8 | §二 表头「B2（选定）」与正文「选 B1」矛盾 | 表头改为「B2：寄宿 dsh（未选）」 |
| T9 | 数量失真：`claude/engine` 实为 **22 文件 1996 行**（v2 写 2047）；逐字节相同仅 9/22，另有 3 个在 `src/` 无对应（`deps.ts`/`http.ts`/`types.ts`），`timedRequest.ts` 属已分叉 | 更正数字；B1′ 下整目录删除，3 个独有文件随之废弃 |
| T10 | §4.2 漏掉第二个写入方：`applyCardSettings` 整份回写**保留**未知键，而 CLI `config set` 白名单重建**抹掉**它们 → 非对称腐蚀 | §4.2 明写两个写入方必须共用白名单，并加 S2 验收 |
| T11 | §5.4 用的 `serve.idleExitSeconds` 在 §4.2 的 schema 里不存在 | schema 补该字段 |
| T12 | `/config` 壳的必需字段未定义 | 补 `searxng.engines` 相关字段集 |
| T13 | `claude/tests/timedRequest.test.ts` import `vitest`，与 `plugin test` 的 `claude-code/testing` 不兼容 | **整目录删除**（`claude/engine/` 一起删，`makeRequestText` 也随之不存在）。`src/util/timedRequest.test.ts`（191 行）已覆盖同一语义，无需迁移 |
| T14 | omp 的 `enabled=false` 只能靠手动跑命令，与「配置里选择宿主」冲突 | `hosts sync` 在 disable 时**主动改写** omp 配置（写回 `web/public`、清空 endpoint），并加 S5③ 验收 |
| T15 | 架构性问题：服务被两个本来能独立工作的宿主依赖，而缓存共享本可由磁盘缓存承担 | 服务收缩为 **omp 专属**（B1′，见 §二、§五） |
| T-R1 | §6.3 写 `providers.webSearch: searxng` | **实测两者行为一致**（都是 `Provider: SearXNG`、本地命中 1）。改选 `modelRoles.web` 的理由是「可在同处声明 `web/public` 回退」，不是「旧键迁移」 |

## 一、目标与非目标

一次 npm 安装，三宿主共用一份配置，在配置里选择每个宿主是否接入。

| 宿主 | 形态 | 版本 | 接入方式 | 是否有独立执行路径 |
|---|---|---|---|---|
| dsh | Cordis 插件 | 0.2.2-rc.3 | `ctx.web.registerSearchProvider` → 子进程调 `dist/kernel.js` | 有，不需要服务 |
| Claude Code | Mod（插件） | 2.1.329 | `hooks/register.ts` 拦截 `tool.call` → 子进程调 `dist/kernel.js` | 有，不需要服务 |
| omp | 原生 SearXNG provider | 19.0.1 | `searxng.endpoint` + 路由键 → 本地 HTTP 服务 | 无，**只有这一条路** |

**非目标**：omp 自定义搜索 provider（宿主不支持，已证）、Claude Code 工具名去掉 `mcp__searchfuse__` 前缀（宿主强制）、为三家一致而降低主协议信息量。

## 二、替代方案与取舍（两轮评审共同要求）

| 维度 | A：每宿主一份实现 | B1：服务服务三家 | **B1′：服务只服务 omp（选定）** | B2：寄宿在 dsh |
|---|---|---|---|---|
| 一份代码 | 否，三份漂移 | 是 | 是 | 是 |
| 额外进程 | 无 | 有，恒常驻 | 有，只为 omp 起 | 无（寄生 dsh） |
| omp 可用性 | 是，独立 | 是，独立 | 是，独立 | 否，绑死 dsh |
| dsh/Claude 有无单点 | 有，无单点 | 有，**都依赖服务** | 有，**无单点** | 无 |
| 缓存共享 | 无 | 有，服务内 | 有，磁盘缓存（已存在） | 有 |
| 鉴权面 | 无 | 三家 | **仅 omp 一个消费者** | 三家 |

**为什么排除 A**：已在 `claude/engine/` 上产生 22 文件 1996 行的分叉（9 个逐字节相同、10 个已分叉、3 个独有）。

**为什么排除 B2**：omp 是唯一没有替代路径的宿主；服务寄宿 dsh 会让「只装 omp」的用户永远搜不了。

**为什么排除 B1（服务服务三家）**：第二轮评审的最强反论——dsh 与 Claude Code **本来每次调用就起独立进程**（dsh `runCli()`, `dsh/index.js:225,1573`），而**跨进程缓存共享磁盘缓存已经做到了**（`src/aggregate/cache.ts` 的 `~/.searchfuse/cache.json`，本机实测存在）。为它们接入服务所买的，是它们已经免费拥有的东西；换来的是三家共同承担端口、token、在途计数这些新故障面。

**最终选择 B1′**：聚合实现只有一份（`src/`），但**运行时不必共享**。

```
                       src/  →  dist/kernel.js （导出 runSearch）
                                    │
        ┌───────────────────────────┼──────────────────────────────┐
        │                           │                              │
   dsh 插件                    Claude Code Mod               serve（HTTP，仅 omp）
   spawn kernel.js            spawn kernel.js              SearXNG 壳 + /v1/*
        │                           │                              │
        └── 磁盘缓存 ~/.searchfuse/cache.json ─────────────────────┘
```

**这三条路径共用同一个内核与同一份磁盘缓存**，所以「一份实现」仍然成立，但没有任何宿主因为另一个宿主而在默认路径上依赖一个常驻进程。

**A 的尸体处置**：`claude/engine/` 删除（见 §三）。其中 `aggregate/rrf.ts`、`canonicalUrl.ts` 与 5 个 `util/` 文件已核实**逐字节相同**，属纯冗余；`cache.ts` 已语义分叉（磁盘 → `$.store`），`providers/index.ts` 仍是 `items: []` 桩，`firecrawl.ts.todo` 连扩展名都不是 `.ts`。

## 三、架构

```
searchfuse/
├─ src/                          # 唯一实现
│  ├─ aggregate/                 # rrf / canonicalUrl / fanout / cache
│  ├─ providers/                 # 各引擎
│  ├─ util/                      # apiKeys / host / redact / explicitProxy
│  ├─ config.ts                  # 配置读写（真身）
│  ├─ doctor.ts                  # 统一诊断入口
│  ├─ kernel.ts                  # 【新增】导出 runSearch 的 ESM 入口
│  ├─ config-schema.ts           # 【新增】两个写入方共用的白名单（→ dist/config-schema.js）
│  └─ serve/                     # 【新增】SearXNG 壳（仅 omp 用）
│     ├─ server.ts               # HTTP
│     ├─ lifecycle.ts            # 固定端口 + 在途计数
│     └─ searxngShell.ts         # SearXNG 兼容壳
├─ dsh/                          # dsh 绑定
├─ omp/                          # 【v5 新增】omp 扩展源码
│  └─ extension.ts               # registerTool: x_search / read_page
└─ claude/                       # Claude Code Mod 绑定
   ├─ .claude-plugin/plugin.json # 必须含 hooks 与 mcpServers
   ├─ hooks/hooks.json           # {"modules":["./register.ts"]}
   ├─ hooks/register.ts          # 唯一手写代码
```

**`omp/` 目录存在（v5 推翻 v4 的「不建」决定）**：v4 说 omp 侧只需配置写入，但 §5.1 的第二条启动路径（扩展在 `session.start` 拉起服务）和 `x_search`/`read_page` 工具注册都需要扩展代码。凭空删掉那条启动路径会让「机器重启后无人拉起服务」变成真实缺口。因此 v5 建该目录，源码由 `hosts sync` 复制到 `~/.omp/agent/extensions/`。

**`claude/engine/` 删除（v3 关键决定）**。B1′ 下 Claude Code 不再需要自己持有引擎实现——它和 dsh 一样 `spawn` `dist/kernel.js`。因此那 22 文件 1996 行**整体删除**，不是改写。

这是本轮最省事的方案：v2 试图「从 `src/` 构建生成 `claude/engine/`」，但第二轮评审指出这条路走不通——

- `src/providers/httpFetch.ts:12` 与 `src/util/timedRequest.ts:1` 都 `import { Agent, EnvHttpProxyAgent } from 'undici'`
- hooks 模块加载器的硬限制原文：「a hooks module imports its own files by relative path and `claude-code`, nothing else」
- 所以产物带一条 `undici` import 就**加载即拒**

绕开它的办法是 shim 层，但 shim 层本身是新的单点，且没有阶段拥有它。**删掉整个 `claude/engine/` 让这个问题消失**：Mod 侧不再有引擎代码，只有 `hooks/register.ts` 一个文件负责 `spawn`。

**代价**：Claude Code 每次搜索多一次进程启动（dsh 侧实测 p50 214 ms）。这与它现在的行为一致（hook 本来就在独立 worker 里跑），所以不是新增成本。

**`dist/kernel.js` 是同源断言的落点**（修正 v2 的循环论证）：新增 vite entry `kernel`，导出 `runSearch(config, query, opts)`。CI 断言改为**双向清单**——生成清单内每个文件都存在，且 `dist/` 下不存在清单外的文件。

**底层函数已存在（实测）**：`src/search.ts:203` 已有 `export async function runSearch(options: RunSearchOptions): Promise<RunSearchResult>`，返回的 `RunSearchResult` 含 `meta.durationSeconds`（恰好是 Claude Code `WebSearchOutput` 的必需字段）。所以 `kernel.ts` 只是一层薄包装，不是新逻辑。

**该薄包装已实测编译通过（v6）**：用一段等价代码（argv 解析 → `runSearch` → stdout JSON）跑 `tsc --noEmit`，除缺 `@types/node` 的 `process` 之外**零类型错误**。说明 `RunSearchOptions` 的字段映射与返回值序列化都对得上，S1⑤ 的契约不是纸上要求。


**kernel 的 I/O 契约（v5 写死，v4 未定义）**：

```
调用：  node dist/kernel.js --query <text> [--source web|x] [--max-results N]
                            [--timeout MS] [--deadline MS] [--engine NAME]
输出：  stdout 单行 JSON = RunSearchResult { mode, query, url, results[], meta{generatedAt,durationSeconds} }
退出码：0 = 有结果；1 = 无结果/全部引擎失败；2 = 参数错误
诊断：  stderr 自由文本（不参与解析）
```

dsh 现有 `runCli()` 传 `-q/--source/--timeout/--deadline`（`dsh/index.js:227-238`），必须与上面这套对齐——**要么改 dsh 的参数名，要么在 kernel 里同时接受 `-q` 与 `--query`**。选后者（兼容），因为改 dsh 会动到已验证的代码。


## 四、配置

### 4.1 唯一真身与迁移（CRITICAL）

`~/.searchfuse/config.json`。**现有两套路径已分叉**（本机实测：`~/.modsearch/config.json` 568 字节、`~/.searchfuse/config.json` 651 字节，后者多一个 `anysearch.apiKey`；两者都含真实 exa / tavily 密钥）。

`dsh/index.js:686` 的 `modsearchConfigPath()` 返回 `~/.modsearch/config.json`，判定为 bug。

**迁移规则（v1 缺失，Critic 3.2）**：现有 `migrateLegacyDir()` 的规则是「新目录已有同名文件就跳过」，这会导致 `.modsearch` 里的 key **静默丢失**。改为**按键级合并**：

- 新文件已有的键优先（用户在新名下的选择）
- 新文件缺的键从旧文件补入
- 冲突的 `apiKey`：保留新文件值，并在 `searchfuse doctor` 输出中列明「旧文件存在不同值」
- 合并结果写回前先备份 `.modsearch/config.json.bak-<时间戳>`

**本机实测（v6）**：现有两份真实配置对比——旧文件**无任何独有键**，新文件是旧文件的超集（19 个共有路径，值全同；新文件多 `engines.anysearch`）。所以对这个用户，合并结果 = 新文件本身，不丢数据。但通用风险仍成立：只在旧文件里配过某引擎的用户会被整文件跳过规则丢数据，因此按键级合并不能省。

### 4.2 schema（复用现有形状，v1 的顶层 `order`/`mode` 作废）

依据 `src/config.ts:106-136` 的 `ModsearchConfig`，**不引入第二套字段名**：

```jsonc
{
  "engine": "anysearch",              // 现有：首选引擎
  "engines": { ... },                 // 现有：各引擎设置
  "aggregate": {                      // 现有：不要写成顶层 mode
    "mode": "rrf",                    //   rrf | chain
    "deadlineMs": 8000,
    "cacheTtlMs": 300000
  },
  "mcp": { ... },                     // 现有
  "cooldown": "on",                   // 现有
  "allowPrivateNetwork": false,       // 现有
  "hosts": {                          // 【新增】
    "dsh":        { "enabled": true },
    "claudeCode": { "enabled": true },
    "omp":        { "enabled": true }
  },
  "serve": {                          // 【新增】
    "port": 7799,
    "idleExitSeconds": 0
  }
}
```

**`serve.token` 不在这份 schema 里**（v2 曾把它写成两个真身）。token 只存在于 `~/.searchfuse/serve-token`，与配置分离——配置会被用户手动编辑、复制、备份，秘密不该跟着走。

**跨平台权限的真实边界（v8 实测）**：POSIX（Linux/macOS）上创建该文件用 `mode: 0o600`，有效。**Windows 上 `chmodSync(0o600)` 不报错但完全不生效**——实测写入后 `stat` 仍是 `666`。因此 Windows 侧的 token 对同机其他用户账户是**可读的**。这不改变设计（token 只保护 127.0.0.1 上的本地服务，且 Windows 的 `%USERPROFILE%` 默认只有本账户可访问），但**不能声称 0600 在所有平台生效**。`doctor` 在 Windows 上跳过权限判定，与 `docs/security.md:13` 的既有口径一致。

**两个写入方必须共用白名单（v3 新增 CRITICAL，实测发现）**：

| 写入方 | 行为 | 危险 |
|---|---|---|
| `src/config.ts` 的 `setConfigValue` → `writeConfigFile`（`:731`） | **白名单重建**，只搬已知键 | `hosts`/`serve` 不在名单 → **静默抹掉** |
| `dsh/index.js` 的 `applyCardSettings` → `writeConfigFile`（`:980`） | `JSON.stringify(config)` **整份回写** | 未知键被保留 |

同一份文件有两个语义相反的写入方，用户会看到「有时在有时不在」。处置：两个写入方共用同一个白名单函数，并加 S2 验收「卡片保存后再 `config set`，`hosts` 仍在」——这才是真实顺序。

**共用白名单的落点（v5 补，v4 缺失）**：`dsh/index.js` 是手写 JS，够不到 TypeScript 源码（该文件自述「够不到 TS 源码」），而 `vite.config.ts` 只产出 `main` / `mcp-protocol` / `mcp-registry` 三个 entry。因此必须新增一个可从 dist 加载的模块：

- 新增 `src/config-schema.ts`，导出 `KNOWN_TOP_LEVEL_KEYS` 与 `rebuildConfig(raw)`
- `vite.config.ts` 增加 entry `config-schema` → `dist/config-schema.js`
- `dsh/index.js` 改为 `import('../dist/config-schema.js')` 调用 `rebuildConfig`，不再自己 `JSON.stringify`
- `package.json` 的 `files` 已含 `dist`，无需额外改动

**此项已加入 S2 验收 ④。**

**白名单搬运（CRITICAL）**：`src/config.ts:374-398` 是白名单式重建，注释自述「新增的顶层段除非在这里被搬运过去，否则就会被丢掉」。`hosts` 与 `serve` **必须**加入该函数，否则每次 `searchfuse config set` 都会静默抹掉它们。

### 4.3 谁读配置（裁决 v1 的循环依赖）

v1 说「服务是唯一读者」，但宿主需要知道 `hosts.<name>.enabled` 才能决定要不要连服务——这是循环。裁决：

| 读者 | 读什么 | 何时 |
|---|---|---|
| **服务** | 全部（引擎、聚合、mcp） | 每次请求 |
| **各宿主适配层** | **只读 `hosts.<self>.enabled` 这一个布尔** | 启动时一次 + 每次调用前（dsh 5 秒轮询 / Claude Code 每次 hook / omp 不读） |

宿主侧读的是**同一个文件、只读一个键**——但 Claude Code 的那一路需要一次**镜像**，原因见下。

**Claude Code 的读取方式（v6 补写入方，修正 v5 的只读断链）**：`claude/hooks/register.ts` 用 `$.settings.read({ key: 'searchfuseHosts' })`，读的是宿主合并后的 settings。之所以不直接读 `~/.searchfuse/config.json`：宿主二进制明确「插件不得写 settings 文件，只能 `$.settings.read`」，而 hooks 沙箱的 `$.fs` 有路径限制。

因此开关是**镜像**而非直接读取：`hosts sync` 把 `~/.searchfuse/config.json` 的 `hosts.claudeCode.enabled` 写进 `~/.claude/settings.json` 的 `searchfuseHosts.claudeCode.enabled`。镜像仍是单向派生（真身在 `~/.searchfuse/config.json`），不构成第二份真身；但**必须有人写**——v5 只写了读取侧，导致 hook 永远读到 `undefined` 而静默失效。此项已进 S4⑤ 验收。

**`plugin.json` 的 `userConfig` 作废（v5 裁决）**：现有的 `engineOrder` / `apiKey` / `aggregateMode` / `searxngEnabled` / `cacheTtlSeconds` 是第四套配置面，与 `~/.searchfuse/config.json` 重复。**全部删除**，理由：一处配置真身；`userConfig` 里的 `apiKey` 还会把密钥带进 Claude Code 的 settings 副本。保留的只有 `hosts.claudeCode.enabled` 的读取路径（经 `searchfuseHosts`）。


## 五、本地服务（仅服务 omp）

服务是 **omp 的适配器**，不是三家的共同执行点。dsh 与 Claude Code 不依赖它。

### 5.1 端口与生命周期（v4：补上启动与重启归属）

**固定端口 7799，不漂移。**

**服务由谁启动（v3 完全缺失，是最关键的缺口）**：v3 只有手动 `searchfuse serve`，而服务空闲 300 秒会自动退出，于是稳态是「omp 需要服务 → 服务 5 分钟后自己死 → 没人拉起 → 静默走公网」。

v4 给出三条启动路径，且**默认不空闲退出**：

| 场景 | 谁启动 | 何时 |
|---|---|---|
| `searchfuse hosts sync` 之后 | `hosts sync` 自己 | 写入 omp 配置后立刻拉起并探活 |
| omp 每次搜索前 | **omp 扩展**（`pi.on('session_start')` → `node:child_process.spawn`） | 源码在 `omp/extension.ts`，由 `hosts sync` 装到 `~/.omp/agent/extensions/` |
| 手动/常驻 | `searchfuse serve --daemon` | 可选 |

**`serve.idleExitSeconds` 默认改为 0（不退出）**。理由：v3 的 300 秒空闲退出与「没有人重启」组合，必然导致 omp 静默失效。需要回收内存的用户可显式设正值并自行承担重启责任。

**端口被占用 → 服务不启动**，`searchfuse doctor` 报告，omp 侧表现为回退到公网（见 §6.3 的实测事实）。

- `searchfuse hosts sync` 职责（v6 补 Claude Code 开关的写入方）：
  - omp enable：写 `searxng.endpoint` + `modelRoles.web` + **`searxng.token`（取自 `~/.searchfuse/serve-token`）**，写前清 `basicUsername`/`basicPassword`（Basic 优先会遮蔽 Bearer）；omp disable：写回 `web/public` 并清空 `searxng.endpoint`/`token`/`basicUsername`/`basicPassword`
  - **Claude Code：读 `~/.searchfuse/config.json` 的 `hosts.claudeCode.enabled`，镜像写入 `~/.claude/settings.json` 的 `searchfuseHosts: { claudeCode: { enabled: <bool> } }`**。写前备份 `settings.json`；**只改 `searchfuseHosts` 这一个键，其余原样保留**（解析→改键→回写，禁止整份覆盖，否则会抹掉用户的 `permissions`/`hooks`/`enabledPlugins`）。理由：宿主二进制明确「插件不得写 settings 文件，只能 `$.settings.read`」，所以镜像必须由插件之外的 CLI 完成
  - Claude Code 的 MCP 声明
  - omp 扩展：把 `omp/extension.ts` 复制到 `~/.omp/agent/extensions/`

**`modelRoles.web` 的选型理由（v4 更正 T-R1 的论证）**：实测 `providers.webSearch: searxng` 与 `modelRoles.web: "web/searxng"` **行为一致**（两者都让 `omp search` 走本地）。本项目选 `modelRoles.web` 的理由是**同处可以声明 `web/public` 作为第二候选**，而不是「`providers.webSearch` 是旧键」（该说法未获实测支持）。

### 5.2 鉴权

服务持有 API key 且提供 `/v1/read-page`。**只有一个消费者（omp），所以只有一个 token。**

- 启动时生成随机 token，写入 `~/.searchfuse/serve-token`（POSIX 用 `0o600`；Windows 忽略权限位，见 §4.2 的跨平台说明）
- **除 `/healthz` 外的全部端点**校验 `Authorization: Bearer <token>`（`/healthz` 免鉴权，见 §5.3）
- **token 轮换的处理（v6 补）**：服务重启会换 token；`hosts sync` 只在安装时写一次，重启后 omp 会拿旧 token 撞 401 然后**静默回公网**。处置：服务启动时若检测到 omp 配置指向自己且 token 已变，**打印可直接复制执行的修复命令原文**（`searchfuse hosts sync`）；`doctor` 输出同样的命令而不只是「指向它」。**不自动改写 omp 配置**（越界），但必须有可操作的信号。
- omp 用原生 `searxng.token`（`searxng.ts:143` 确认发 `Authorization: Bearer`）
- **Basic auth 优先级高于 Bearer**（`:121`）：`hosts sync` 写配置前必须先清除 `searxng.basicUsername`/`basicPassword`，否则 401
- `/v1/read-page` 在**服务侧**执行私网拦截

### 5.3 端点

| 端点 | 形状 | 消费者 | 鉴权 |
|---|---|---|---|
| `/search?q=&format=json&pageno=` | SearXNG 壳（含 `unresponsive_engines`） | omp | Bearer |
| `/config` | SearXNG 壳，供引擎快捷名解析 | omp | Bearer |
| `/v1/x-search` | X 语料（omp 扩展直调） | omp 扩展 | Bearer |
| `/v1/read-page` | 正文提取（omp 扩展直调） | omp 扩展 | Bearer |
| `/__stats` | `{ localHits: number }`（v6 补表） | S5 验收 | Bearer |
| `/healthz` | 文本 `OK` | `hosts sync`/`doctor` 就绪探测 | **免鉴权**（v6：否则探活需先读 token，把「起了但 401」误判为「没起」） |

**`localHits` 的口径与存活期（v7 定义）**：

- **算什么**：`/search` 成功应答的次数（HTTP 200 且结果非空）。不含 `/v1/*`，不含失败请求。
- **存多久**：**进程内计数，随服务重启归零，不落盘**。理由：它是测试/诊断用计数器，不是业务状态；落盘会引入一个新的状态文件与清理义务。
- **对 S5 的约束**：S5② 的 baseline 与复测**必须在同一个服务进程内完成**，否则「计数归零」与「服务新起」无法区分，该条会退回假绿。

**`/config` 的必需字段（v3 补 T12）**：omp 在设置 `searxng.engines` 时会请求它并读 `config.engines[]`，每项需 `name` 与可选 `shortcut`（见 `searxng.ts:167-195`）。缺这个字段时 omp 不会失败（`/config` 失败返回 null 后原样透传引擎名），但快捷名解析会失效。

**SearXNG 壳必须带 `unresponsive_engines`**（`searxng.ts:473`）：omp 依赖它在结果为空时保真上游原因。格式是 `[engine, reason]` 元组数组。

**壳必须容忍 `pageno=1`**（实测 omp 会带上）。

### 5.4 空闲退出与在途请求

**在途请求计数 > 0 时绝不退出**：退出前再等 2 秒确认归零。`serve.idleExitSeconds` 默认 **0（不退出）**，见 §5.1。

omp 的 `providers.webSearchTimeoutSeconds` 默认 60（实测），远大于聚合默认 `deadlineMs` 8000，不会互相拖死。

## 六、三家接入

### 6.1 dsh

dsh **不接服务**，继续走子进程路径，但目标从 `dist/main.js` 换成 `dist/kernel.js`：

- `dsh/index.js:686` 改指 `.searchfuse`
- `registerSearchProvider` 内部调 `spawn(process.execPath, [kernelPath, ...])`——与现状同构，只是不再经过 CLI 参数解析
- **不依赖服务**，所以 §5.1 的端口占用对 dsh 无影响
- `hosts.dsh.enabled === false` 时**只关 provider，不早退整个 `apply`**——`apply` 还负责 `ctx.webServer.register('/searchfuse/config')`（`dsh/index.js:1522`），那是 Web 用户唯一的设置入口
- `apply` 拿到的是宿主配置（`cordis.patch.yml`），`hosts.dsh.enabled` 来自共享文件——两者是**不同层次**，不能混用

### 6.2 Claude Code

**只走 `spawn` `dist/kernel.js`，不走 HTTP**（v4 消除 v3 的同节自相矛盾：v3 一段说 spawn kernel、另一段说走 curl）。

理由：Claude Code 是本地进程，`spawn` 一个 Node 子进程直接拿到结构化结果，不需要经过 HTTP + 序列化 + token。HTTP 只有 omp 需要（它只会发 HTTP）。

`claude/hooks/hooks.json`：

```json
{ "modules": ["./register.ts"] }
```

**`plugin.json` 的 `hooks` 字段必须写 `"./hooks/hooks.json"`（带 `./`）**——实测写 `"hooks/hooks.json"` 会报 `hooks: Invalid string: must start with "./"`。

`claude/hooks/register.ts` —— **v4 修正：原 v3 的示例通不过 `claude plugin validate`**。实测错误：

```
$ is passed to "helper", which is not a function declared at the top of this file
$ is always spelled $.noun.event(...) at the call site
```

`$` **不能**作为普通参数传给自由函数，必须**在每个 hook 体内直接命名空间调用**。正确形态（**已实测通过 `claude plugin validate` 的类型检查**）：

```ts
// 文件顶部声明所有辅助函数（validate 要求：函数声明或 const 绑定）
function toNativeSearchShape(raw: unknown, toolUseId: string) {
  // …
}

export function register(on: any) {
  on('tool.call', { tool: 'WebSearch' }, async ($: any, e: any, next: any) => {
    // 开关：读共享配置的 hosts.claudeCode.enabled（见 §4.3，v5 统一键名）
    const enabled = await $.settings.read({ key: 'searchfuseHosts' })
    if (enabled?.claudeCode?.enabled !== true) return next(e)
    // spawn kernel：$ 调用直接写在 hook 体内
    // v5：用 globalThis 取 process（直接写 process 会 TS2591）
    const run = await $.process.run({
      argv: [(globalThis as any).process.execPath, <kernelPath>, '--query', e.query],
      timeoutMs: 240_000,
    })
    if (run.exitCode !== 0) return next(e)

    return { result: toNativeSearchShape(JSON.parse(run.stdout), e.tool_use_id) }
  })
    .catch(($: any, e: any, next: any) => next(e))
}
```

**v5 类型修正（实测证伪 v4 的示例）**：
- `on` / `$` / `e` / `next` 必须显式标 `: any`，否则 `TS7006`（4 条）
- 直接写 `process.execPath` 会 `TS2591`（宿主 `types: []`，无 Node 类型），须用 `(globalThis as any).process`
- `--strict` 会把上述 warning 升为 error，所以规范的写法必须一次到位

**`$.settings.read({key})` 的返回形状（v6 实测确认）**：返回的是**该键的原值**，不是 `{ value }` 包裹。实测把 `{searchfuseHosts:{claudeCode:{enabled:true}}}` 写进 settings 后，hook 内读到 `{"claudeCode":{"enabled":true}}`。因此 `enabled?.claudeCode?.enabled !== true` 是正确写法。

另：`session.start` 钩子抛异常会被宿主**静默跳过**（只向 stderr 打 `hook skipped: threw Error…`），不影响会话继续——这也是为什么 S4④ 要求断言「`next` 被调用恰好一次」而不是只看是否有报错。

**`validate` 的硬规则（实测，必须遵守）**：
- `$` 只能在 hook 体内部以 `$.noun.method(...)` 出现
- 辅助函数必须在**文件顶层**声明（函数声明或 const 绑定），不能在 `register` 内部定义后再被 `$` 调用
- 不能 `import` 任何非相对路径、非 `claude-code` 的模块

**`claude plugin validate` 必须进 CI（v4 新增，零成本的红测试）**：实测它能抓到三类问题：
```
cannot import "undici" (from hooks\register.ts): a hooks module imports its own files by relative path and "claude-code", nothing else
$ is passed to "helper", which is not a function declared at the top of this file
Export named 'it' not found in module 'claude-code/testing'
```

**`claude plugin test` 不可作为门槛（实测证伪）**：测试**失败**时仍 `EXITCODE=0`（实测 0 pass / 1 fail → exit 0），与它自己的 `--help`「Exits 1 when a test fails」矛盾。且 `claude-code/testing` **没有导出 `it`**，只有 `test`。

**关键修正**：
- `import type { Register } from 'claude-code'` **删除**（tsc 实测 `TS2307`）
- v2 的 `.catch(($, e, next) => next.called ? next(e) : next(e))` 两分支同一表达式，是死代码；v3 改为真正的回退语义
- 参数用 `any` 而非宿主类型，避免依赖不存在的 `.claude-plugin/types/`

关键约束：

- **不走 HTTP**：`$.http.fetch` 单次 30 秒、响应体 4 MiB 会卡死长搜索；`spawn` + `$.process.run` 上限 10 分钟。因此也不需要 `curl` 与 `--noproxy`。
- **不能用 `WebFetch` 工具**：`web-fetch-dotless-host` 硬拒 loopback。
- **返回形状必须匹配 `@anthropic-ai/claude-code/sdk-tools.d.ts:3939` 的 `WebSearchOutput`**（`query`、`results`、`durationSeconds` 为 required）。v1 写的 `claude-code-tools/index.d.ts` **不存在**。
- `durationSeconds` 的语义：取聚合真实墙钟，不是宿主计时。
- `x_search` / `read_page` 用 `$.tool.register`，全名被强制为 `mcp__searchfuse__x_search`。
- **`Register` 类型不在宿主包里**：实测全局安装**没有** `.claude-plugin/types/`，唯一 `.d.ts` 是 `sdk-tools.d.ts`；`import type { Register } from 'claude-code'` 编译报 `TS2307`。处置：`hooks/register.ts` **不写类型导入**。

### 6.3 omp（v4：统一实测事实，消除 v3 三处互斥）

**实测对照表**（本地假 SearXNG，未动用户配置）：

| 配置 | 实际走向 | 本地命中 |
|---|---|---|
| 仅 `searxng.endpoint` | 公网 Parallel（10 条） | **0** |
| `+ --model searxng` | 本地 SearXNG | 1 |
| `modelRoles.web: "web/searxng"` | 本地 SearXNG | **1** |
| `providers.webSearch: searxng` | 本地 SearXNG | **1** |
| `modelRoles.web: "web/searxng,web/public"` | 本地 SearXNG | 1 |
| **服务返回 401** | **公网 Parallel，exit 0** | **0** |
| **服务根本没起** | **公网 Parallel，10 条，exit 0，stderr 空** | **0** |

**结论（v4 统一口径，替换 v3 三处互斥的说法）**：

1. `searxng.endpoint` 只是 provider 的地址，**不是选择开关**
2. `providers.webSearch` 与 `modelRoles.web` **两者都能路由**；本项目选 `modelRoles.web`，因为可在同处声明 `web/public` 作第二候选
3. **omp 确实有回退，但退到公网、静默、exit 0**。这不是我们的代码能改变的宿主行为。v3 三处说「有回退」/「无回退」互斥，v4 统一为：**回退存在，但目标不是「安全的后备」，而是「公网」**
4. 因此 `hosts.omp.enabled = false` 必须由 `hosts sync` **主动改写配置**（把 `modelRoles.web` 写回 `web/public`、清空 `searxng.endpoint`），否则 omp 依然会走本地服务

正确写法（`hosts.omp.enabled = true` 时写入 `~/.omp/agent/config.yml`）：

```yaml
searxng:
  endpoint: http://127.0.0.1:7799
  token: <serve token 内容，非路径>
modelRoles:
  web: "web/searxng,web/public"   # 首选本地；服务不可达时退公网
```

**`modelRoles.web` 配 `web/searxng` selector**：omp 的 `priority.json`（在 `@oh-my-pi/pi-coding-agent/src/priority.json`，**不在本仓库**）里 `web` 清单包含 `web/searxng`，`webSelectors()`（`settings.ts:3022-3037`）把 provider 名映射成 `web/<provider>` 形式的 **model selector**。实测 `providers.webSearch: searxng` 与 `modelRoles.web: "web/searxng"` **行为一致**；本项目选后者，因为可在同处声明 `web/public` 作第二候选。

`web/public` 作为第二项就是 omp 侧的回退目标（omp 在首选失败时前进到下一位）。**注意：这是「退到公网」，不是「退到安全后备」**——实测服务不可达时 omp 静默走公网、exit 0、stderr 空。

**实测验证（v3）**：临时把 `~/.omp/agent/config.yml` 改成上述写法（`modelRoles.web: "web/searxng"` + `searxng.endpoint: http://127.0.0.1:<port>`），跑 **不带 `--model`** 的 `omp search`，输出 `Provider: SearXNG`，本地探针命中 1 次。配置已还原。这证实了正确写法确实生效，也证实 v1 的「只写 endpoint」确实不够。

`enabled = false`：`hosts sync` **主动改写配置**（v5 统一，消除 v4 第 365 行与第 389 行的互斥）——把 `modelRoles.web` 写回 `web/public`、清空 `searxng.endpoint`、清空 `searxng.token`/`basicUsername`/`basicPassword`。理由：omp 没有任何运行时开关机制，不改写就等于 `enabled=false` 无效。改写前先备份 `~/.omp/agent/config.yml`，并只动这三个键，其余原样保留。

**omp 扩展的职责（v6 修正 API 名）**：扩展只注册 `x_search` / `read_page` 两个工具并在 `session_start` 拉起服务，**不碰搜索**（搜索走原生 provider）。

**omp 扩展的真实 API（实测核实，v3-v5 误写成 Claude Code 的 `$` DSL）**：

```ts
// @oh-my-pi/pi-coding-agent 的扩展契约（不是 Claude Code 的 $）
import { spawn } from 'node:child_process'

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async () => {   // 下划线，不是 session.start
    // 拉服务：用 node:child_process，扩展里没有 $、没有 process.spawn
    // servePath 由 hosts sync 渲染成绝对路径后写进扩展文件首行常量
    // （模板占位替换，不是裸复制——裸复制后扩展与 dist/ 已无相对关系）
    spawn(process.execPath, [SERVE_PATH, '--ensure'], { detached: true, stdio: 'ignore' }).unref()
  })
  pi.registerTool({
    name: 'x_search', label: 'X Search', description: '…',
    // 真实签名：pi.zod / pi.typebox / pi.arktype 三选一，没有裸 type()
    parameters: pi.zod.object({ query: pi.zod.string() }),
    // 真实 execute 签名：首参是 toolCallId，params 在第二位
    execute: async (toolCallId: string, params: { query: string }) => { /* … */ },
  })
}
```

依据：`dist/types/extensibility/extensions/types.d.ts:872` 的事件名是 `session_start`；`:459` 的 `ToolDefinition` 形状是 `{ name, label, description, parameters, execute }`；`ExtensionContext` 只有 `cwd`/`sessionManager`/`invokeTool`，**没有 `$`**；本机唯一的真实扩展 `~/.omp/agent/extensions/pebrel.ts` 用的就是 `node:child_process`。

扩展文件由 `searchfuse hosts sync` 从本包的 `omp/extension.ts` **渲染**（模板占位替换，不是裸复制）写到 `~/.omp/agent/extensions/`，替换两处：`SERVE_PATH`（`dist/serve.js` 的绝对路径）、`TOKEN_PATH`（`~/.searchfuse/serve-token` 的绝对路径）。

扩展调 `/v1/x-search`、`/v1/read-page` 时读 `TOKEN_PATH` 拼 `Authorization: Bearer`；读不到 token 时这两个工具返回明确错误并**不影响搜索**（搜索走原生 provider，不经过扩展）。

## 七、命名差异（接受，不强求统一）

| 能力 | dsh | Claude Code | omp |
|---|---|---|---|
| 搜索 | `web_search` | `WebSearch`（被接管） | `web_search`（经 provider） |
| X 语料 | `x_search` | `mcp__searchfuse__x_search` | `x_search` |
| 网页阅读 | `read_page` | `mcp__searchfuse__read_page` | `read_page` |

Claude Code 的前缀由 `$.tool.register` 强制。

## 八、MCP 内置

`config.mcp` 是唯一来源。**现有 `McpServerConfig` 只有 `transport/url/headers`，没有 token 字段**（Critic 缺口 6）。处置：

- token 不新增字段，而是由适配层在写入各家格式时拼进 `headers.Authorization` 或 URL query
- context7 用 header，grep 免鉴权
- 三处落点：dsh 复用 `src/mcp/registry.ts`（走 `ctx.tools.register`，非 `ctx.mcpManager`——v1 写错）；Claude Code 写 `plugin.json` 的 `mcpServers`；omp 写 `~/.omp/agent/mcp.json`（实测该文件确被 omp 读取）

**凭据规则**：包里只预置端点，不预置 token。任何人把私有 token 打进公开包视为发布阻断项。

## 九、SearXNG

- `engines.searxng.baseURL` 是**必需**的（`src/providers/searxng.ts` 明确 `isAvailable` 依赖它），v1 的 `baseURL: null` 会导致该引擎静默不跑
- 内置实例启停后必须**把实际地址写回 `baseURL`**，否则 S1 的 `curl /search` 只有 anysearch 结果
- **禁止 `baseURL` 指回服务自身端口**：聚合器 → 自己的壳 → 聚合器会形成闭环（Critic 缺口 3）。服务侧启动时检测并拒绝
- 缺失时：`searxng` 引擎 `isAvailable` 为 false，其他引擎照跑；`doctor` 报告「未就绪」
- Windows 缺二进制：官方源有 `@searxng-js/win32-x64@0.1.3`，npmmirror 缺；文档写明 `--registry=https://registry.npmjs.org`

## 十、验收（每条必须是「能失败的红测试」）

v1 的验收可被 40 行桩骗过，v2 的 S4 经实测也无效——`claude plugin test` **从不执行 hooks 模块**（实测：`register.ts` 写 `throw new Error("BOOM")`，仍 exit 0）。以下替换。

| 阶段 | 交付 | 验收（必须能红） |
|---|---|---|
| S1 | `src/serve/` + `src/kernel.ts` | ① 无 token 请求 → 401；② 在途请求未完成时 `idleExit` 不触发（2 秒慢引擎 + 5 秒 idle，断言进程仍活）；③ `/search` 含 `unresponsive_engines`；④ `/config` 返回 `engines[].name`；⑤ **`spawn dist/kernel.js --query x` 得到可解析的 `RunSearchResult`**（含 `results` 与 `meta.durationSeconds`）；⑥ **`GET /__stats` 返回 `{ localHits }`**；⑦ **`~/.searchfuse/runtime.json` 含 `{ pid, startedAt, version }`**（由 `src/serve/lifecycle.ts` 在服务就绪后写入、退出时删除） |
| S2 | 配置 schema + 迁移 + 白名单 | ① **卡片保存后再 `config set`**，`hosts` 与 `serve` 仍在；② 两份分叉配置迁移后旧 key 出现在新文件且生成 `.bak`；③ 新值不被覆盖；④ **`dist/config-schema.js` 存在且被两个写入方 import**（v5：否则 dsh 那侧够不到 TS 源码） |
| S3 | dsh 接 kernel | ① **`--engine <name>` 钉死链式（或 `aggregate.mode: chain`）时 `results[].attempts` 非空**；默认 `rrf` 路径下 `attempts` **恒为 `[]`**（实测 `src/search.ts:479`、`:511`），所以不能无条件断言它；② 服务未启动时也正常（dsh 不依赖服务） |
| S4 | Claude Code Mod | ① **`claude plugin validate claude`（不加 `--strict`）退出码 0，且 stdout 含 `Validating hooks` 与 `calls:` 段**（`Validating hooks` 不出现 = 没读到 hooks 模块，此时恒绿）；② **真实触发 `tool.call`**：`claude -p "..." --plugin-dir claude`，断言结果来自 searchfuse——**已实测该机制可用**；③ `WebSearchOutput` 形状断言，`tool_use_id` 取自 hook 的 `e`；④ hook 抛错时 `next` 被调用**恰好一次**；⑤ **`searchfuse hosts enable claudeCode && searchfuse hosts sync` 后 `$.settings.read({key:'searchfuseHosts'})` 能读到 `claudeCode.enabled === true`；`searchfuse hosts disable claudeCode && searchfuse hosts sync` 后为 `false`**（v7：命令名与 §十二 的三个动词对齐） |
| S5 | omp 接入 | ① 不带 `--model` 时 `omp search` 命中本机：**`/__stats` 的 `localHits` 增 1**；② 服务未启动时：**`localHits` 不变、`omp` 退出码 0、输出条数 ≥ 10**（三个条件同时成立才证明「它退到公网了」；v4 只断言计数为 0，在未接入时也成立，无区分力）；③ `hosts sync`（enable）后 `searxng.endpoint` 与 `modelRoles.web` 都已写入；④ **`hosts sync`（disable）后 `modelRoles.web == "web/public"`、`searxng.endpoint` 为空、`basicUsername`/`basicPassword` 已清** |
| S6 | parity 矩阵 | `npm run parity:final` 通过：每格测试名文件真实存在且出现在文件里（脚本已实测） |
| S7 | npm 发布 | `npm pack --dry-run` 含 `claude/`（含 `hooks/hooks.json`）、**`omp/extension.ts`**、`dsh/` |

## 十一、分发

`package.json` 的 `files` 当前不含 `claude/` 与 `omp/`（实测 `npm pack --dry-run` 33 个文件里两者都是 0 条）：需补全两项。

## 十一·五、跨平台（Linux / macOS / Windows）

三宿主都要在三个平台上可用。不是"顺便兼容"，是**硬约束**——每条都要有对应的实现方式或明确的降级说明。

| 关注点 | Linux / macOS | Windows | 实现方式 |
|---|---|---|---|
| 拉起子进程 | `process.execPath` | 同左 | 直接用 `process.execPath`，三平台一致；**不要**用 `'node'` 裸名（Windows 上不保证在 PATH） |
| 可执行文件后缀 | 无 | `.exe` | 需要解析外部 `curl`/`agy` 时用 `src/system.ts` 的 `platform === 'win32' && extname === '' ? [bin + '.exe'] : [bin]`（已有） |
| 路径拼接 | `/` | `\` | 一律 `path.join` / `path.dirname`，**禁止**手写 `'/'` 拼路径；URL 里的 `/` 除外 |
| `~` 展开 | shell 负责 | 同左 | Node 代码里一律 `os.homedir()`，不解析 `~`（已有 `src/config.ts:144`） |
| 文件权限 `0o600` | 生效 | **静默无效** | 见 §4.2：POSIX 用 mode，Windows 跳过判定；`doctor` 不报 Windows 的权限问题 |
| 目录 `0o700` | 生效 | 静默无效 | 同上 |
| 原子写（临时文件 + rename） | `renameSync` 原子 | **同样可用**（已实测） | `src/config.ts:710-731` 的「写临时文件 → rename」在三平台都成立。实测 Windows 上 `fs.renameSync(tmp, existing)` 成功覆盖，内容为新值——Node 内部已处理 POSIX/Windows 差异，**不需要额外兼容代码** |
| 端口 7799 被占 | 报错并降级 | 同左 | 行为一致，不依赖平台 |
| 服务进程随父进程退出 | 需显式 `detached: false` | 同左 | `spawn` 默认不 detach；`serve --ensure` 拉起后由服务自己管生命周期 |
| 换行符 | LF | CRLF | 写配置一律 `JSON.stringify(…, null, 2)` + `'\n'`，不依赖平台默认；读入用 `split(/\r?\n/)` |
| 路径大小写 | 大小写敏感 | **不敏感** | 比较路径时不要假设大小写敏感（例如 `hosts sync` 判断"是否已安装"时用 `realpath` 归一） |

**已实测（Windows）**：

1. 已验证：`fs.renameSync(tmp, existing)` **成功覆盖**，内容为新值——原子写方案无需平台分支
2. 已验证：`spawn(process.execPath, [脚本, '--query', 'hello'])` 完整可用：exit 0、参数正确传递、stdout 可读
3. 未验证：macOS 的 `0o600` 生效情况尚未实测（POSIX 语义与 Linux 一致，风险低）

**实测得到的平台差异只有一处需要代码分支**：`0o600` 在 Windows 静默无效（`stat` 仍 `666`）。其余（`execPath`、`rename`、路径拼接、换行）三平台行为一致，因此**不为它们写 `if (platform === 'win32')` ——那才是真正的过度工程**。

## 十二、CLI 落点

现有 `src/main.ts` 有 **8 个**子命令（实测 `grep -c "\.command(" = 8`）：`search` / `doctor` / `config` / `init` / `set <key> [value]` / `show` / `state` / `clear`。

新增需接入 commander：

- `serve`：启动服务
  - `serve --ensure`：**幂等拉起**——已在跑（`/healthz` 通）则 exit 0，否则启动；omp 扩展与 `hosts sync` 都用它
  - `serve --daemon`：常驻（不随空闲/父进程退出）
- `hosts`：`enable <name>` / `disable <name>` / `sync`（写各家配置并探活）

`vite.config.ts` 的 entry 必须加**三项**：`kernel`（导出 `runSearch`）、`serve`、`config-schema`（现只有 `main`/`mcp-protocol`/`mcp-registry`）。

## 十三、Pre-mortem（v1 完全缺失，Critic 缺口 7）

假设半年后这个方案失败了，最可能的六个原因：

1. **服务静默不启动**：端口 7799 被占，用户看到的是「搜索没结果」而不是「服务没起」。→ 处置：`doctor` 必须能一句话区分「服务没起」与「引擎全挂」。**注意：v3 的「打一行 stderr」被实测证伪——omp 服务不可达时 stderr 为空、exit 0。因此唯一可靠的信号是 `doctor` 与 `hosts sync` 的探活输出，不能依赖 omp 侧任何提示。**
2. **omp 每次搜索走公网**：路由键没写全（v1 的错误就是这个）。→ 处置：S5 验收用探针计数，不用 `--model`。
3. **配置被 `config set` 抹掉**：`hosts`/`serve` 没进白名单。→ 处置：S2 验收 ①。
4. **旧 key 丢失**：迁移规则是「已存在就跳过」。→ 处置：S2 验收 ②③。
5. **Claude Code 返回形状不合规**：`durationSeconds` 语义错、`results` 结构错，整次调用被拒。→ 处置：S4 验收 ③。
6. **服务没人管**：`hosts sync` 拉起后，机器重启或进程被杀，没有任何东西重启它，omp 从此静默走公网。→ 处置：`idleExitSeconds` 默认 0；`doctor` 检查进程存活；可 `--daemon` 或加开机自启。

## 十四、测试计划（v1 只有 unit，缺三层）

| 层 | 覆盖 | 工具 |
|---|---|---|
| unit | config 白名单搬运、迁移合并、端口占用、SearXNG 壳字段映射、`unresponsive_engines`、输出形状 | vitest |
| integration | 三家各一条真机链路；服务被杀后的降级矩阵 | vitest + 真机脚本 |
| e2e | 三宿主同时在线；`npm pack` 产物完整；**`claude plugin validate`（不加 `--strict`）退出码 0 且含 `Validating hooks`**（与 S4① 一致；不用 `--strict`：实测它被 README/LICENSE/icon 干扰；不用 `plugin test`：实测它失败也 exit 0） | CI |
| observability | `searchfuse doctor` 覆盖 `serve / config / engines / mcp / hosts` 五段 | vitest 断言 `DoctorReport` |
| 生命周期（v4 新增） | 服务启动/端口占用/在途计数/`hosts sync` 后探活；**omp 服务不可达时的真实降级矩阵**（退公网、exit 0） | vitest + 真机脚本 |

`src/doctor.ts` 已覆盖 `config/engines/mcp/cooldown`（`doctor.test.ts` 400+ 行），需扩展 `serve` 与 `hosts` 两段。

## 十五、已知风险（v1 只有 5 行，以下是补全）

| 风险 | 严重度 | 处置 |
|---|---|---|
| 新增顶层键被 `config set` 静默抹掉 | **CRITICAL** | 进白名单 + S2 验收 |
| 两套配置已分叉，迁移丢 key | **CRITICAL** | 按键级合并 + 备份 + S2 验收 |
| omp 回退目标是**公网**（宿主限制：静默、exit 0、stderr 空） | MAJOR | 明确写出，不粉饰；`doctor` 报告服务不可达 |
| 服务无鉴权 | MAJOR | Bearer token + read-page 私网拦截 |
| `claude/engine/` 分叉副本 | MAJOR | **整体删除**（B1′ 下 Mod 走 kernel 子进程，不需要引擎代码） |
| 端口 7799 被占 | MINOR | 只影响 omp（dsh/Claude 不依赖服务）；**omp 侧无任何提示**，靠 `doctor` 报告 |
| omp 看不到引擎失败细节 | MAJOR | 壳必须带 `unresponsive_engines` |
| `claude/hooks/hooks.json` 缺失 | MAJOR | 补入布局 + S4 验收 |
| CI 无 `claude/` 类型检查 | MAJOR | 加 `tsc -p claude/tsconfig.json`；其 `include` 需去掉已删除的 `engine/**` |
| 系统代理可能改道本地请求 | MINOR | Claude Code 走 spawn 不受影响；omp 的 HTTP 客户端若尊重代理需在文档提示 |
| npmmirror 缺平台包 | MINOR | 文档写明官方源 |

## 十六、实施顺序

S2 → S1 → S3 → S4 → S5 → S6 → S7。S2 必须在 S1 之前完成，因为服务要读正确形状的配置（v5 修正 v4 的顺序自相矛盾）。

## 十七、ADR

**Decision**：三宿主共用**一份实现**（`src/` → `dist/kernel.js`），但**不共用运行时**。dsh 与 Claude Code 各自 `spawn` kernel；omp 走本地 HTTP 服务（SearXNG 壳）。

**Drivers**：① omp 无自定义 provider（`SearchProviderId` 封闭枚举，已证）；② 现有 `claude/engine/` 已分叉 22 文件 1996 行（9 同 / 10 分叉 / 3 独有）；③ 用户要求「一份代码 N 宿主」；④ `undici` 与 Node 内置使 Mod 沙箱无法直接复用 `src/`。

**Alternatives considered**：
- A（每宿主独立实现）：无单点，但已在 `claude/` 产生分叉
- B1（服务服务三家）：一份代码，但两个本来能独立工作的宿主被迫依赖一个常驻进程，而缓存共享磁盘缓存已做到
- B2（寄宿 dsh）：零额外进程，但 omp 可用性绑死 dsh

**Why chosen**：B1′ 让服务只服务唯一没有替代路径的宿主（omp），另外两家走子进程。这样「一份实现」成立（同一 `src/`、同一磁盘缓存），同时没有宿主因另一宿主而在默认路径上新增失败面。

**Consequences**：`claude/engine/` 22 文件 1996 行删除；新增 `dist/kernel.js` entry；omp 的服务不可达时**退到公网**（宿主行为，静默）；服务仍需鉴权（单消费者、单 token）；dsh/Claude 每次搜索多一次进程启动（约 214 ms，与现状一致）；`serve.idleExitSeconds` 默认 0。

**Follow-ups**：S1 落地后测 `idleExit` 与在途请求竞态；S5 落地后用 `/__stats` 的 `localHits` 验证 omp 主路径真的命中本地；S4 落地后用 `claude -p --plugin-dir` 证明 hooks 真的被执行。
