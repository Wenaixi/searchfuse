# 本地服务生命周期：让三条宿主链路都能自愈

> 状态：**pending approval**
> 日期：2026-11-24
> 仓库：`E:\newCC\aaa-dsh-go\dsh-modsearch`（`@wenaixi/searchfuse`）
> 前置：`2026-11-21-searchfuse-tri-host-design.md`（该文档第 610 行已记录本问题为已知风险，至今未处置）

## 一、问题

`~/.searchfuse/runtime.json` 是三个宿主发现本地服务的唯一途径。它记录服务的端口与 token，由 `serve --daemon` 写入、由 `serve` 的 `close()` 删除。

2026-11-24 实测：该文件**不存在**，且没有任何 `serve` 进程在运行。后果分两侧：

- **omp**：扩展自带「用时拉起」（`fetchOrSpawn` → `tryServe` 失败 → `wakeServe` 跑 `serve --ensure` → 重试），所以它能自愈。实测 `~/.omp/` 那份扩展包含完整的三级链路。
- **Claude Code**：`claude/hooks/register.ts` **没有**这套。服务不在时它退回 `$.process.run` 直接跑 kernel 子进程——每次搜索都多付一次进程启动，且失败时日志里只有一条 ENOENT，看起来不像故障。

这正是前置设计文档已识别、但从未处置的风险：**服务没人管，机器重启或进程被杀之后，没有任何东西把它拉回来。**

### 为什么不能用开机自启解决

实测三条系统级自启路径**全部静默失败**（本机会话 `IsAdmin=False`）：

| 方案 | 实测 |
| :-- | :-- |
| `Register-ScheduledTask` | 打印 `registered`，任务库里查不到 |
| `schtasks /create` | 完全无输出，任务不存在 |
| 启动目录写 `.cmd` | `PermissionError: Permission denied` |

静默失败比报错更危险：调用方看到成功，用户以为装上了。所以本设计**不依赖任何系统权限**。

## 二、目标与非目标

**目标**

1. Claude Code 侧在服务不可用时能自己拉起来，与 omp 侧行为对齐。
2. 三条宿主的自愈判据来自同一处，不各写一份。
3. 卡片能显示「服务在不在」，并提供一次手动拉起。

**非目标（明确不做）**

- 不做开机自启、不注册计划任务、不写启动目录。（理由见上。）
- 不做常驻守护进程。「用时拉起 + 空闲退出」已经覆盖实际需求，守护进程是本机不需要的复杂度。
- 不改 `serve` 本身的启动、鉴权、端口分配逻辑。它是对的。
- 不改 dsh 侧。dsh 插件是当前进程，它加载时服务有没有无所谓——它自己就是调用方。

## 三、设计

### 3.1 唯一判据：`ensureServeRunning()`

新建 `src/serveEnsure.ts`，导出一个函数：

```ts
export async function ensureServeRunning(
  options?: { timeoutMs?: number },
): Promise<{ started: boolean; port?: number; reason?: string }>
```

行为，按顺序：

1. 读 `runtime.json`。文件不存在 → 直接进入第 3 步。
2. 用文件里的端口探 `/healthz`（2 秒超时，`Connection: close`）。200 就返回 `{ started: false, port }`。
3. spawn `node <dist/main.js> serve --ensure`，`stdio: 'ignore'`、`windowsHide: true`、**`detached: true` 并 `unref()`**。
4. **轮询 `/healthz`**（每 500ms，总上限 20 秒），直到通了或超时。
5. 通了就再读一次 `runtime.json` 拿端口；拿不到返回 `{ started: false, reason: 'runtime.json not written' }`。

**为什么不能等子进程退出码（2026-11-24 实测纠正）：**

`serve --ensure` 有两种退出行为。服务已在跑时它 `process.exit(0)` 立刻退出；
服务不在跑时它打印 `Listening on ...` 之后**常驻不退出**（`src/main.ts:326-333` 只写 stdout，没有 exit）。

所以「等退出码」在真正需要起服务的那条路上**永远等不到**，超时到点杀掉子进程，
杀掉的正是刚起来的服务——服务白起一次、被判失败、还被干掉，三重错误。

实测证据：隔离 `HOME` 下 spawn `serve --ensure`，8 秒后进程仍活、`/healthz` 返 200、
`runtime.json` 已写出。

**子进程必须 detached 且不杀。** 它本来就是常驻服务，杀掉它是本设计的自相矛盾。
残留由下次 `--ensure` 复用：它先探 `/healthz`，通了就 exit 0。

**为什么复用 `serve --ensure` 而不是自己起服务**：`--ensure` 已经处理了「端口 0 由内核分配」「已在跑就退 0」两个边界，自己在插件里重写一遍就会漂移。这条命令是唯一真源。

**为什么先探 `/healthz` 再 spawn**：`runtime.json` 存在但服务已死是最阴的状态（`CLAUDE.md` 有记录）。直接 spawn 会撞上仍被占用的端口。

### 3.2 三个调用点

| 位置 | 时机 | 失败时 |
| :-- | :-- | :-- |
| `claude/hooks/register.ts` | `searchOrRead` 发现 runtime.json 读不到，且 `$.process.run` 兜底也失败之后 | 保持现状：交回 `next(e)` |
| `dsh/index.ts` 插件启动 | `apply` 末尾，`ctx.effect` 里 | 静默：dsh 自己能用 CLI |
| `omp/extension.ts` | 已有，不改 | — |

Claude 侧**只在两条路都失败后**才 ensure，理由是这个 hook 在每个 `tool.call` 上都会跑，每次都 spawn 一个进程太贵。判据是「这次真的用不上服务了」，而不是「服务好像不在」。

`dsh/index.ts` 的启动 ensure 必须**不阻塞 `apply`**：`void ensureServeRunning()`，失败只记一行日志。插件加载慢 5 分钟是不可接受的。

### 3.3 卡片新增一个动作

`POST /searchfuse/config` 现有的 `applyCardSettings` 处理 `patch` 的各段。新增一个独立动作而不是塞进 patch：

```json
{ "action": "ensureServe" }
```

处理：调 `ensureServeRunning()`，返回 `{ ok, port, message }`。**同步等待**，因为 `--ensure` 在服务已跑时是毫秒级；只有真要起服务时才慢，而那时用户本来就是点了「拉起」。

卡片上的落点：服务状态行 + 一个「拉起」按钮，仅在 `runtime.json` 缺失或 healthz 不通时出现。

GET 侧 `engineSummary` 新增 `serve: { running: boolean, port?: number }`。判据与 `ensureServeRunning` 的第 1、2 步共用同一个函数，不各写一份。

### 3.4 顺手消掉 omp 的假阳性（已完成）

`ompStatus` / `ompHostStatus` 拿模板原文比已安装文件，而安装时会渲染占位符，导致每一次正确安装都被报成陈旧。已在 `1b5cd79` 修复：比对前用与安装相同的渲染。

这一项不进本 spec 的实现范围，但它是本 spec 的直接前提——如果检测器还在撒谎，「服务状态」也会用同样的方式撒谎。

## 四、验收

每一条都是可失败实测，不是「应该可以」。

| # | 断言 | 怎么验 |
| :-- | :-- | :-- |
| S1 | `ensureServeRunning` 在服务已跑时返回 `started: false` 且不改 runtime.json | 先起 daemon，记录 mtime，调用，比对 mtime 不变 |
| S2 | 服务已死但 runtime.json 存在时，`ensureServeRunning` 能拉起并更新端口 | kill 进程、保留文件（手写一份指向死端口）、调用、`/healthz` 200 |
| S3 | runtime.json 缺失时能拉起 | `rm` 文件、调用、`/healthz` 200 |
| S4 | Claude hook 在服务不可用时仍能返回搜索结果 | 删 runtime.json，跑一次 `claude -p` 搜索，断言结果非空 |
| S5 | `POST {action:'ensureServe'}` 返回 200 且带 port | 直接调路由 handler（用 CLAUDE.md 里的最小夹具） |
| S6 | 跨站请求仍被 403 拒绝 | `Origin: https://evil.example` 打 POST，断言 403 |
| S7 | dsh 插件启动不因 ensure 失败而卡住 | 用一个不存在的 `SEARCHFUSE_CLI_PATH` 环境变量模拟失败，加载插件，断言 apply 在 5 秒内返回 |

## 五、风险

| 风险 | 处置 |
| :-- | :-- |
| Claude hook 每次 tool.call 都 spawn | 只在 HTTP 与子进程两条路都失败后才调，且有超时上限 |
| ensure 在无 node 的环境失败 | 返回 `reason`，调用方按现有逻辑降级；不抛异常 |
| 卡片「拉起」按钮被跨站触发 | 复用现有同源 + 循环地址 + JSON content-type 三重守卫 |
| dsh 插件在快照里跑，`../dist/main.js` 指向副本 | 从 `PACKAGE_ROOT` 推路径，不假设与源码树同构 |
| `PACKAGE_ROOT` 在 `dsh/index.ts` 里是编译产物所在的包根，在 `src/` 里是源码树根 | `serveEnsure` 放在 `src/`，它用 `import.meta.url` 推自己的位置；`dsh/` 侧把 CLI 路径通过参数传进去，不各算一次 |

## 六、实现顺序

1. `src/serveEnsure.ts` + 单元测试（S1、S2、S3）
2. `dsh/index.ts`：`engineSummary` 加 `serve` 段、路由加 `action`、启动 ensure
3. `dsh/client.ts`：服务状态行 + 拉起按钮
4. `claude/hooks/register.ts`：两条路失败后 ensure
5. 端到端（S4、S7）

前三步可以独立提交，第 4 步必须前三步落地后再做（它依赖 `serveEnsure` 的实现位置）。
