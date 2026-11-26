# SDD ledger — plan: docs/superpowers/plans/2026-11-24-serve-lifecycle.md

> 状态：历史执行账本。记录的是当时每一轮的实际动作，不是现状说明。

工作台：`.superpowers/sdd/2026-11-24-serve-lifecycle/`
分支：`feature/serve-lifecycle`（从 `main` 的 `030a679` 切出）
Spec：`docs/superpowers/specs/2026-11-24-serve-lifecycle-design.md`

## 派发前冲突扫描

| # | 任务对 | 一方产出 | 另一方消费 | 结论 |
| :-- | :-- | :-- | :-- | :-- |
| 1 | T1 → T2 | `ensureServeRunning` / `readServeRuntimeFile` | T2 消费同义行为 | **冲突**：`dsh/` 不能 import `src/`（实测 TS5097）。计划已改为 T2 自足实现。见 Ruling 1 |
| 2 | T2 → T3 | `summary.serve`、`{action:'ensureServe'}` | T3 渲染状态行与按钮 | 一致 |
| 3 | T2 内部 | 文件清单写 `dsh/client.ts` | 步骤里没有任何 client.ts 改动 | **冲突**：文件清单写错，client.ts 属 T3。见 Ruling 2 |
| 4 | T2 内部 | `engineSummary()` 加 `serve: await serveStatus()` | 该函数当前是同步（`dsh/index.ts:1096`） | **冲突**：加 await 会把它变成 async，波及 3 个调用点。见 Ruling 3 |
| 5 | T1 → T5 | `ensureServeRunning` | T5 用 `import('./dist/serveEnsure.js')` | 一致（需先 `pnpm build`，计划已注明） |
| 6 | T4 → T1 | `serveCliPathFromKernel`（T4）| T1 不产此函数 | 一致：T4 自足，计划正确回避了跨树 import |
| 7 | T4 内部 | 测试断言 `serveCliPathFromKernel` | 实现在 `src/hosts.ts` | 一致 |
| 8 | T5 内部 | 验 S4/S7 | 无独立断言 | 已知缺口，计划已声明 |

## Rulings

Ruling: T2 自足实现 `serveStatus` / `startServe`，不 import `src/serveEnsure.ts`
— 实测跨树 import 会满屏 TS5097，把整个 src 拉进 dsh 编译
— 若错：判据有两份实现，改一处时另一处可能漂移；缓解是 T5 验收两边都验。

Ruling: T2 的文件清单删掉 `dsh/client.ts`，前端改动全部归 T3
— T2 的步骤里没有任何 client.ts 内容，清单是从早期的合并草稿残留下来的
— 若错：T3 会与 T2 重复改同一个文件；缓解是 review 时比对两份 diff。

Ruling: `engineSummary` 改为 async，并更新全部 3 个调用点（GET 路由、POST 路由、`__config`）
— 计划要求 `serve: await serveStatus()`，而它当前同步；不 await 就只能下发一个 Promise，卡片拿到的是 `{}`
— 若错：async 化波及测试与 `__config` 导出，需一起改；缓解是 T2 的测试必须覆盖 GET 路由真实返回。

补充（已实测缩窄）：`src/dshPlugin.test.ts` **不直调** `engineSummary`，全部走 HTTP 路由 handler，
所以 async 化只影响 `dsh/index.ts` 内部 3 个调用点（GET 路由、POST 路由、`__config` 导出），测试侧无波及。
新增测试一律走路由 handler，不要直调 `engineSummary()` 或 `serveStatus()`。

Ruling: Task 1 实现者用 `withTempHome()` + `closedPort()` 重写了我 brief 里的测试，接受
— 我 brief 的版本把临时 runtime 写在系统临时目录、而函数读真实家目录，断言验的是一个函数从未碰过的文件；
且本机 61746 上真有 serve 在跑，原测试必红。实现者的版本消除了本机状态依赖，是可复现的
— 若错：无明显代价，新写法更严格。

Ruling: 保留对 `src/util/spawnHidden.ts` 的宽重载改动
— 窄签名在前、宽签名在后，现有管道式调用方不会被退化；注释已说明顺序理由。`stdio: 'ignore'` 的调用必须有个匹配的签名
— 若错：重载解析可能让某个调用方拿到 `ChildProcess` 而非 `ChildProcessByStdio`；缓解是全量 tsc 已 0 错误。

Ruling: `src/serveEnsure.ts` 未进 vite 构建入口，留到 Task 5 处理
— 它是 `src/` 的模块，`vite build` 的 entry 配置决定产物；Task 5 要用 `dist/serveEnsure.js`
— 若错：Task 5 的 S1–S3 验收会找不到产物；缓解是 Task 5 第一步就检查并补 entry。

**已核实（2026-11-24）：`vite.config.ts` 的 `lib.entry` 只有 5 个（main / mcp-protocol / mcp-registry / config-schema / kernel），没有 serveEnsure。**
所以 `dist/serveEnsure.js` 现在不会被构建。Task 5 必须先把
`'serve-ensure': resolve(__dirname, 'src/serveEnsure.ts')` 加进 entry，再跑 `pnpm build`。
这是 Task 5 的必做前置，不是可选优化。

## 进度

Task 1: 实现完成（commits ff3d7e1..e9451a5，4 个提交），进入审阅
- ff3d7e1 新增 ensureServeRunning
- 709fc6a 补 ChildProcess 类型
- a178540 改走 spawnHidden + 宽重载
- e9451a5 补早退路径测试
- 实现者做过反向验证：短路早退分支后只有新测试变红，证明它有守护力
- 审阅包：review-030a679..e9451a5.diff
- 审阅者因 API 524 挂掉，但死前抓到一条 Critical，我已独立实测确认

Ruling: **`ensureServeRunning` 的「等子进程退出码」模型是错的，改为「spawn 后轮询 /healthz」**
— 2026-11-24 实测：`serve --ensure` 有两种退出行为。已在跑 → `process.exit(0)`；
不在跑 → 打印 `Listening on ...` 后**常驻不退出**（src/main.ts:326-333 只写 stdout，没有 exit）。
所以「等退出码」在真正需要起服务的那条路上永远等不到，超时到点 `child.kill()` 杀掉的正是刚起来的服务。
实测证据：隔离 HOME 下 spawn `serve --ensure`，8 秒后进程 62120 仍活、healthz 200、runtime.json 已写出。
— 若错：服务每次都被拉起又被杀掉，永远起不来；缓解是轮询 healthz + detached。
— 代价：`started` 的语义要从「子进程退出 0」改成「healthz 通了且 runtime.json 有可用端口」。

Ruling: 子进程必须 `detached: true` + `stdio: 'ignore'` + `unref()`，不再 kill 它
— 它本来就是 `serve --ensure` 拉起的常驻服务，杀掉它是本设计的自相矛盾
— 若错：父进程退出后子进程可能收不到信号；缓解是 `serve` 自己幂等，残留由下次 `--ensure` 复用。

Ruling: spec 的 §3.1 第 3 步与计划的 Task 1 Step 3 都按上述模型修正，Task 2 的 `startServe` 同步修正
— 两处是同构实现，错一处另一处必然跟着错
— 若错：两处行为不一致；缓解是 Task 5 两边都验。

Task 1: 修正完成（d1d9488，2 files changed, 85 insertions, 33 deletions）
- 改为轮询 /healthz 判就绪，detached + unref，不 kill
- 测试 6/6（新增超时路径）、spawnContract 4/4、两个 tsconfig 0 错误
- 实现者两处主动收紧，我接受：
  (a) 退出 0 不作终局（继续轮询，让 healthz 说了算）—— 符合「成功只有一个判据」
  (b) 非 0 退出立刻收手 —— 优化而非缺陷：CLI 明确报错时再等满超时毫无意义
- 实现者实测纠正了一个 brief 细节：`/nonexistent/main.js` 走的是「退出码 1」分支，
  不是 `error` 事件（node 能启动、找不到模块才报错退出）
- spec 与计划已同步修正（§3.1 第 3-5 步、Task 1 Step 3、Task 2 的 startServe）
- 审阅包：review-030a679..d1d9488.diff，复审进行中

Task 1: complete (commits 030a679..31204e9, review clean —— 复审子代理连续两次被 API 524 打断，
改由协调者本人做定向核查)
- 协调者核查五项全过：早退路径、不杀子进程、成功判据唯一、非 0 早收手、测试守护力
- 反向验证三次：
  (a) 破坏早退分支 → 只有早退测试红
  (b) 破坏轮询成功分支 → **7 条全绿，说明成功路径零覆盖**（真缺陷，已补）
  (c) 补测后再破坏成功分支 → 只有新测试红
- 补测提交 31204e9：假 CLI 模拟 serve --ensure 真实行为（拉起服务 + 写 runtime.json + 常驻）
- 最终 7/7 测试、两个 tsconfig 0 错误、biome 干净

Ruling: 复审两次被 API 524 打断后，改由协调者本人做定向核查，不再派第三次
— 524 是推理网关的临时故障（`api.wenxi.dev`），不是代码问题；再派只会第三次超时
— 若错：我可能漏掉审阅者的独立视角；缓解是我做了三次反向验证，比读 diff 更能暴露缺口。
  这是本任务唯一一次「控制器自己动手」，代价已记在这里。

Ruling: Task 2 复用既有的 `readServeRuntime()`（`dsh/index.ts:587`），**不新建重复函数**
— 实测该函数已存在，且已经返回 `{ port, token }` 并做形状校验；计划里写「新建 readServeRuntime」是重复实现
— 若错：无，复用永远优于重复。
- 但它有一个缺口：只判 `typeof parsed.port === 'number'`，**不校验整数**。
  Task 1 的 `src/serveEnsure.ts` 用的是 `Number.isInteger`。两处判据必须一致，
  所以 Task 2 要做的是**给既有函数补整数校验**，而不是另起一份。

Ruling: 子代理连续三次 524 后，Task 2 起改由协调者在主会话直接实现
— 三次同一个错误说明网关对长任务不稳定，不是偶发；再派第四次只会浪费更多时间
— 若错：失去「实现与审阅分离」的纪律；缓解是每个任务落地后仍跑全量测试 + 反向验证

Ruling: **删除 `apply()` 末尾的自动拉起**（spec §3.2 与计划 Task 2 Step 5 的原设计作废）— 实测它会污染既有测试：`apply` 时无条件 spawn `serve --ensure` 并轮询 healthz，
  把 `dsh web search provider` 与 `dsh CLI budgets` 两组共 5 条测试打下线
  （stub 的请求计数里多了一个 `/healthz`、`requests[0].path` 不再是 `/v1/search`）
— 而且它本来就违反三条：拖慢每次插件加载、dsh 自己走 CLI 根本不需要服务、
  用户没在用服务时也白起一个常驻进程
— 改为**懒拉起**：只有卡片上的「拉起」按钮（POST action）会真的 spawn。
  这正是 spec §3.3 已有的那条动作，不需要再加一个自动触发点。
— 若错：服务不会随 dsh 启动自动回来；缓解是 omp 与 Claude 侧各自的 ensure
  仍是主路径，dsh 侧留给用户一键拉起。

**已核实（2026-11-24）：`dsh/index.ts` 里已有的 serve 相关代码**
- `readServeRuntime()`（:587）：读 runtime.json，返回 `{ port, token }`，有形状校验但缺整数校验
- `tryServe()`（:653）：调 `readServeRuntime()`，POST 到 `http://127.0.0.1:<port><endpoint>`，带 Bearer
- `SERVE_FAILURE_PREFIX` / `describeServeFailure()`：区分「服务端业务错误」与「连不上」
- `toServeRequest()`：把 CLI 风格参数翻成服务端路由
所以 Task 2 是在既有链路上**加**三样：`serveStatus()`、路由动作、**卡片手动拉起**
（原计划写「apply 末尾非阻塞拉起」，已被上面的 Ruling 推翻）。
`startServe` 与 `healthOnce` 是唯一真正新增的两个函数。

Task 2: complete (commits ba4925f..3cc37d7, review clean —— 协调者实现并自验)
- `engineSummary` 改 async，新增 `serve: await serveStatus()`
- `registerConfigRoute` POST 支持 `{action:'ensureServe'}`
- `readServeRuntime` 补整数校验与 token 非空校验
- 新增 `healthOnce` / `startServe` / `serveStatus`
- `startServe` 支持 `SEARCHFUSE_SERVE_CLI` 环境变量注入（测试用假 CLI，避免留孤儿）
- 测试 72/72（原 70 + 新增 2）
- 全量 775 通过 8 失败，全部为已知 flaky（kernel.contract 单独跑 6/6、main 单独跑 6/6）
- 端到端实测：GET 报 `{"running":false}` → POST 拉起返回 `{ok:true,port:52868}`
  → GET 报 `{"running":true,"port":52868}`。闭环成立，服务现常驻在 52868。

Task 3: complete (commits 3cc37d7..5ca8133, review clean —— 协调者实现并自验)
- `serveLabel` 三态纯函数（running / stopped / unknown），进 `__card` 导出
- 卡片新增 serve block：状态行 + 拉起按钮（服务在跑时不显示按钮）
- `ensureServe()` 走 `POST {action:'ensureServe'}`，成功后本地更新 summary
- CSS 用既有 token（`--dsw-alias-label-secondary` / `-primary`），无新 token
- 99/99 测试（原 97 + 新增 2 条渲染断言）、两个 tsconfig 0 错误
- 测试里补了 `Card` 接口的 `serveLabel` 声明，否则 src 的 tsc 会报 TS2339

Task 4: complete (commits 5ca8133..b0ee0c8, review clean —— 协调者实现并自验)
- `fetchOrSpawn` 从两条路扩成三条：HTTP → kernel → `wakeServe` 后重试 HTTP
- 第三级放在 `fetchOrSpawn` 内部而不是三个调用点各加一遍（改一处三处受益）
- 抽出 `runKernel` / `wakeServe`；CLI 路径从 kernelPath 推出
- `src/hosts.ts` 新增 `serveCliPathFromKernel` + 2 条测试
- 新增 `src/claudeHook.test.ts`：Claude hook 的第一个测试，3 条
- 桩要复现 `on(...)` 返回可 `.catch()` 的句柄、`next` 可调用且带 signal
- 反向验证：破坏第三级后只有对应那条红
- 30/30（hosts 27 + hook 3）、三个 tsconfig 0 错误
- 实测确认已安装的 register.ts 是旧的（b3ade8da vs 仓库 ed553c62），
  `hosts sync` 后一致，`wakeServe` 在已安装文件里出现 2 次

Task 5: 验收结果（commits b0ee0c8..HEAD）
- 前置：vite.config.ts 补 `serve-ensure` entry，`dist/serve-ensure.js` 已构建（3.39 kB）
- S1 通过：服务已跑时 `started=false`、17ms 早退、mtime 未变
- S2/S3 通过：停服务 + 删 runtime.json 后 `started=true`、602ms、端口 49676、文件已写出
- S5 通过：`POST {action:'ensureServe'}` 返回 `{"ok":true,"port":49676}`
- S6 通过：`Origin: https://evil.example` 返回 403
- S7 通过：apply 耗时 0ms（自动拉起已删，不可能卡住）

Ruling: **S4 无法按原计划验证，改由单元测试替代**
— `claude -p` 在本机跑不起来：日志报 `unrecognized_model deepseek-v4.1-flash-eco[1M]`，
  模型名不被 Claude Code 识别，`generate_session_title` 阶段就失败，压根没走到 tool.call
— 替代：`src/claudeHook.test.ts` 三条用例覆盖同样的三条路径（含「两条路都失败 → serve --ensure」）
— 若错：真实宿主里的行为与单测桩可能有差异；缓解是 `hosts sync` 已把新版装进
  `~/.claude/skills/searchfuse-mod/`，且日志确认 `hooks module searchfuse@skills-dir loaded`

Ruling: 保持服务常驻在 49676
— 它是我验收时拉起来的，对 Claude Code 与 omp 是好事（省掉每次搜索的进程启动）
— 若错：多占一个进程；用户可用卡片上的状态看到它，`serve` 自己也有 idleExit

## 最终全分支审阅（协调者本人做，12 commits / 14 files / 1086 行）

| 检查项 | 结果 |
| :-- | :-- |
| ensureServeRunning 用轮询而非等退出码 | 通过（detached + unref，无 kill） |
| dsh 侧不 import src | 通过（0 处 `from '../src/'`） |
| 卡片无 tooltip | 通过（6 处 title 全为既有，我的 diff 里只有 className） |
| 两处端口判据一致 | 通过（都用 Number.isInteger） |
| engineSummary 三个调用点都 await | 通过 |
| 前后端动作名一致 | 通过（都是 `ensureServe`） |
| 没新增依赖 | 通过（package.json 未变） |
| 三个宿主各有 2 处 wakeServe/startServe | 通过 |

全量测试：44 passed / 49 files，8 个失败全部为已知 flaky
（main.test 6 条、mcp/protocol 1 条、httpFetch.systemCa 1 条——三条单独跑都全绿）
三个 tsconfig 全部 0 错误。

Ruling: 最终审阅由协调者本人做，不派子代理
— 子代理连续三次被 API 524 打断（两个实现 + 一个复审）
— 若错：可能漏掉独立视角；缓解是我按 spec 逐条核对了 8 个关键约束，
  且每个任务都做过反向验证（破坏代码 → 确认对应测试变红）
