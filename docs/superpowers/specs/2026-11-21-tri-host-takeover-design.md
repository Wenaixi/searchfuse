# 三宿主搜索接管与默认 MCP 设计

> 状态：已实施。本文档是当时的**设计决策记录**，不是现状说明；实现如果已经演进，以代码为准。
> 日期：2026-11-21
> 仓库：`E:\newCC\aaa-dsh-go\searchfuse`（`@wenaixi/searchfuse`）
> 取代：`2026-11-21-searchfuse-tri-host-design.md` 中关于「三家如何接入」的部分

## 一、目标

三个宿主（dsh / Claude Code / omp）都用 searchfuse 的聚合搜索**替换**各自的原生搜索工具；`context7` 与 `grep` 作为**默认 MCP 集合**，缺则自动注册。

三条硬要求：

1. **替换原生**，不是「接管 + 回退」——模型只看到我们的工具
2. **随机端口 + 自动保活**，不依赖固定端口或守护进程
3. **共享一份配置**（引擎、密钥、聚合模式），宿主自己的配置各管各的

## 二、已实测确认的事实

每条都是源码或真机验证，不是推断。

| 事实 | 证据 |
|---|---|
| **omp 扩展 `registerTool` 的 `name` 是自由字符串** | `types.ts:635` |
| **omp 扩展注册同名 `web_search` 会覆盖内置工具** | 实测：探针返回 `SHADOW_PROBE_HIT`，模型报告「web_search 被覆盖了」 |
| **omp 覆盖实现**：`toolRegistry.set(name, liveTool)` + `setToolBuiltIn(name, false)` | `sdk.ts:4490-4498` |
| **omp 禁用内置**：`web_search.enabled: false` | `tools/index.ts:749` |
| **MCP 工具名强制 `mcp__<server>_<tool>`**，不能叫 `web_search` | `mcp/tool-bridge.ts:421` |
| **Claude Code `tool.list` 钩子可移除工具** | 二进制原文 `tool.list hooks removed this tool` + **实测返回形状**：`next(e)` 返回 `{ value: [...] }`，`value` 是工具对象数组（每项含 `name`/`description`）（v2 已修） |
| **Claude Code 的 `$.fs.read` 能读仓库外任意文件** | 实测：读 `~/.searchfuse/config.json` 返回 `READ_OK` |
| **Claude Code 的 `$.registerTool` 不接受任意名** | 强制 `mcp__<plugin>__<name>` |
| **omp `searxng.endpoint` 是静态配置，配置文件优先于环境变量** | `web/settings.ts:37` `fallback: "blank"` |
| **dsh 已用 `cordis.patch.yml` 替换 provider** | `searchProvider: modsearch` |

## 三、架构

```
共享层（三家共用，只读）
  ~/.searchfuse/config.json   ← 唯一配置真身：引擎、密钥、聚合模式、默认 MCP
  ~/.searchfuse/cache.json    ← 融合结果缓存（跨宿主命中）
  dist/kernel.js              ← 唯一聚合实现（三家都 spawn 它）

隔离层（各自独占）
  ~/.omp/agent/config.yml            ← omp 自己的设置
  ~/.omp/agent/extensions/searchfuse.ts  ← omp 扩展（同名覆盖）
  ~/.claude/settings.json            ← Claude 自己的设置
  dsh 的 cordis 配置                  ← 宿主层
```

**为什么这样切**：配置真身必须共享（否则三家的引擎密钥各存一份，改一处另两处不知道）；宿主设置必须隔离（`modelRoles`、`permissions`、`hooks` 是各宿主自己的语言，混在一起谁都不认识）。

## 三·五、配置分层：共用 + 可独立

**三层深合并，后者覆盖前者。**

```
1. 全局   ~/.searchfuse/config.json            ← 所有宿主的共同基线
2. 项目   <cwd>/.searchfuse/config.json        ← 这个仓库的覆盖（可选）
3. 宿主   ~/.searchfuse/hosts/<name>.json      ← 只给某个宿主的覆盖（可选）
```

**合并规则**：深合并，**后者已有的键覆盖前者，缺失的键继承前者**。

举例——全局配了三个引擎，只想让 Claude 用另一个 exa key：

```jsonc
// ~/.searchfuse/config.json（全局，所有宿主）
{ "engines": { "exa": { "apiKey": "key-A" }, "tavily": { "apiKey": "key-T" } } }

// ~/.searchfuse/hosts/claudeCode.json（只影响 Claude）
{ "engines": { "exa": { "apiKey": "key-B" } } }

// 结果：Claude 用 key-B + 继承 tavily；其余宿主用 key-A + tavily
```

**为什么深合并而不是浅合并**：浅合并意味着写 `engines` 就整个替换引擎表，用户只想换一把 key 却要把整表抄一遍。深合并让「覆盖一个字段」真的只覆盖那一个字段。

**为什么项目层可选**：多数人不需要按仓库区分密钥。需要的人（比如公司项目用自己的 exa key）放一个 `.searchfuse/config.json` 到仓库根即可，与 `CLAUDE.md` 的工作方式一致。

**三家的读取方式**：

| 宿主 | 全局 | 项目 | 宿主覆盖 |
|---|---|---|---|
| dsh | `ctx.tools.register` 侧读 | 读 `<cwd>/.searchfuse/` | 读 `hosts/dsh.json` |
| Claude Code | `$.fs.read` 绝对路径 | `$.fs.read('.searchfuse/config.json')`（相对路径按会话 cwd 解析，官方文档确认） | `$.fs.read` 绝对路径 |
| omp 扩展 | `node:fs` | `ctx.cwd` + 相对路径 | `node:fs` |

**实现位置**：`src/config.ts` 加一个 `loadLayeredConfig(hostName, cwd)`，把三层合并成一份 `ModsearchConfig` 返回。三家都调它（dsh 通过 dist、Claude 通过 kernel.js 的 `--host` 参数、omp 扩展通过 kernel.js）。

**注意**：`kernel.js` 要接受 `--host <name>` 与 `--cwd <dir>`，才能按宿主解析覆盖层。这是对既有 I/O 契约的扩展。

## 三·六、统一服务形态（v4：两条路）

**三家都走同一个本地服务，服务不在时各自兜底。**

### 为什么能用同一个服务（上次的障碍已解）

之前判定「必须在每家 spawn 自己的实例」，理由是 Claude 的 mod 沙箱没有
`globalThis.process`。**这个理由不成立**——正确的出口是 `$.process.run`：

```ts
// 实测可用：exit=0, stdout=v26.12.1
await $.process.run(['node', '--version'])
```

裸名 `node` 由宿主按 PATH 解析，不需要 `process.execPath`。所以 mod
**能**起子进程，只是必须走 `$`。

### 两条路（v4 收敛）

| 路径 | 何时用 | 实现 |
|---|---|---|
| **HTTP**（首选） | 服务在跑 | `$.http.fetch('/v1/search')`，端口从 `runtime.json` 读 |
| **唤醒 + 重试** | 服务不在 | `serve --ensure` 拉起，再发一次 HTTP |
| **报错/原生** | 都失败 | dsh/omp 报错；Claude 侧 `next(e)` 回退原生 |

原先还有第三级「搜完 spawn 一个一次性 `kernel.js`」，**已移除**（理由见
第五节）。Claude 侧之所以不再 spawn 搜索，是因为服务由 dsh/omp/CLI 负责
拉起，Claude 只当客户端。

**代价对比**：HTTP 省掉一次 Node 启动（约 200ms），但要求服务活着；唤醒
失败时报错，而不是悄悄退化成一个并行实现。

### 路径怎么传给 mod

mod 沙箱里 **`~` 不展开、`$.env.get('HOME')` 返回 undefined**（实测）。
所以两条绝对路径由 `searchfuse hosts sync` 写进 Claude settings：

```json
"searchfuseHosts": {
  "claudeCode": {
    "enabled": true,
    "runtimePath": "C:\\Users\\...\\.searchfuse\\runtime.json",
    "kernelPath": "E:\\...\\dist\\kernel.js"
  }
}
```

mod 通过 `$.settings.read({ key: 'searchfuseHosts' })` 读回来。

### 服务由谁启动

| 宿主 | 能 spawn | 启动责任 |
|---|---|---|
| dsh | 是，Node 进程 | 启动时 `serve --ensure` |
| omp 扩展 | 是，Node 进程 | `session_start` 时 `serve --ensure` |
| CLI | 是 | `hosts sync` 末尾拉起 |
| Claude Code | 是，`$.process.run` | 不主动起（只当客户端，失败回退原生） |

`--ensure` 幂等：已在跑就 exit 0，不会重复起。

## 四、三家如何接管

### 4.1 dsh（保持现状，已实现）

`cordis.patch.yml` 把 `searchProvider` 指向 `modsearch`。宿主原生的 `web_search` 工具名不变，**后端是我们**。

**这是真替换**：用户/模型看到的还是 `web_search`，实际跑的是 7 引擎聚合。

### 4.2 Claude Code

两条钩子，取代当前的「接管 + 回退」：

```ts
// 1. 移除内置 WebSearch —— 模型看不到它
//    实测形状：next(e) 返回 { value: [{ name, description, ... }] }
on('tool.list', async ($, e, next) => {
  const list = await next(e)
  return { ...list, value: list.value.filter((t) => t.name !== 'WebSearch') }
}).catch(($, e, next) => next(e))

// 2. 注册我们的 —— 名字是 mcp__searchfuse__web_search（宿主强制前缀）
on('session.start', async ($, e, next) => {
  await $.tool.register({
    name: 'web_search',
    description: '多引擎聚合搜索',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  })
  return next(e)
})

// 3. 处理调用
on('tool.call', { tool: 'mcp__searchfuse__web_search' }, async ($, e, next) => {
  const run = await $.process.run({ argv: [execPath, KERNEL_PATH, '--query', e.query, '--source', 'web'] })
  if (run.exitCode !== 0) return { result: '搜索失败' }
  return { result: 结果 }
})
```

**为什么改名而不是保持 `WebSearch`**：宿主的 `$.tool.register` **强制** `mcp__<plugin>__<name>` 前缀（实测）。要保持 `WebSearch` 这个名字只能靠 `tool.call` 拦截，而那是「接管 + 回退」，不是替换。

**取舍**：模型看到的工具名变了（`mcp__searchfuse__web_search`），但内置的 `WebSearch` 被移除，所以**没有第二个搜索工具**，仍算「替换」。

### 4.3 omp（扩展同名覆盖）

```ts
// ~/.omp/agent/extensions/searchfuse.ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_search',        // 同名覆盖内置
    label: 'Web Search',
    description: '多引擎聚合搜索',
    parameters: pi.zod.object({ query: pi.zod.string() }),
    loadMode: 'essential',
    execute: async (toolCallId, params) => {
      const run = spawn(execPath, [KERNEL_PATH, '--query', params.query, '--source', 'web'])
      return { content: [{ type: 'text', text: 结果 }] }
    },
  })
}
```

**实测确认可行**：探针返回 `SHADOW_PROBE_HIT`，模型报告「web_search 被覆盖了」。

**omp 不写 `searxng.endpoint`**：那条路在随机端口下不可行（静态配置 vs 动态端口）。扩展内 `spawn` 子进程，端口由内核分配，天然满足「随机端口 + 自动保活」。

## 五、随机端口与保活（v4，已取代本文早先的「每家 spawn」）

早先的判断是「omp 的 `searxng.endpoint` 是静态字符串，所以三家不能共用 HTTP
服务」。那个前提已经不成立：omp 扩展改为**每次调用读 `runtime.json`**，静态
endpoint 不再写进任何配置（`src/main.ts:351-353` 也记下了这一点）。于是三家
可以共用一个服务，端口也可以随机。

| 要求 | 如何满足 |
|---|---|
| 随机端口 | `serve.port` 默认 0（内核分配），实际端口写入 `runtime.json` |
| 自动检测 | `--ensure` **读 `runtime.json` 再探 `/healthz`**，不再猜端口 |
| 自动保活 | 三级收敛为两级：`HTTP → 唤醒(serve --ensure) → 重试 HTTP`；闲置 10 分钟自动退出，下次搜索自动唤醒 |
| 客户端跟上换端口 | 三家都从 `runtime.json` 取 port + token（Claude 侧由 `hosts sync` 写入绝对路径） |

**为什么必须改 `--ensure`**：固定端口探测在随机端口下会探错端口，判定「没在
跑」并另起一个实例——两个实例抢同一份 `runtime.json`，客户端拿到新 token 打到
旧进程，会出现一串难以解释的失败。这是真机踩过的坑。

**移除的那一级**：「搜完 spawn 一个一次性 `kernel.js`」。它绕过服务，让三宿主
本应共享的缓存与冷却状态失效，且是同一查询的第二套实现——出问题时无法判断走
的哪一套。服务起不来就如实报错，把故障暴露出来。

## 五·五、SearXNG：内置实例与逐引擎代理

**内置实例是显式开关，不是默认值。** `searxng.embedded: true` 才由
`@searxng-js/searxng@0.1.2` 拉起；默认关闭，因为那是约 22 MiB 的原生产物，
首次启动有可感知代价。`engines.searxng.baseURL` 语义不变，且优先级更高。

**代理有两层，命名空间不混**：

| 层 | 位置 | 谁实现 |
|---|---|---|
| 我们直连的 6 个引擎 | `engines.<name>.proxy`（单值，三态） | 我们的 undici agent |
| SearXNG 的上游引擎 | `searxng.{outgoing,networks,engines}` | SearXNG 自己 |

第二层完全交给 SearXNG 原生语义：同一协议多个代理由它 `itertools.cycle` 轮询，
我们不维护计数器（维护一份就和上游行为难以对齐）。

**生成 `settings.yml` 时必须自带基础段**：传入 `settingsPath` 会完全替代包里的
`DEFAULT_SETTINGS`，所以 `search.formats: [html, json]` 与 `server.limiter: false`
要自己写上——缺前者会 403（实例只肯渲染网页），缺后者会被限流器拦。

**`extra_proxy_timeout` 在 `outgoing` 层，不在 `networks.<name>` 下**：
SearXNG 的 `Network.__init__` 不接受这个名字，写错层会让实例以
`TypeError: unexpected keyword argument` 直接启动失败。

## 六、默认 MCP：context7 + grep

**规则：缺则注册，有则不碰。**

```ts
const DEFAULT_MCP = {
  context7: { transport: 'streamable-http', url: 'https://mcp.context7.com/mcp' },
  grep:     { transport: 'streamable-http', url: 'https://mcp.grep.app' },
}
```

**三个宿主各自的处理**：

| 宿主 | 已有就跳过 | 缺就注册 | 位置 |
|---|---|---|---|
| **dsh** | `config.mcp` 已有的跳过 | 写进 `config.mcp` | `~/.searchfuse/config.json` |
| **omp** | `mcp.json` 已有的跳过 | 写进 `mcpServers` | `~/.omp/agent/mcp.json` |
| **Claude Code** | `~/.claude.json` 已有的跳过 | 写进 `plugin.json` 的 `mcpServers` | 插件清单 |

**两级检测（两者都要）**：

1. **是否已配置**：先查宿主自己的 MCP 配置里有没有同名 server。有就跳过，不重复注册。
2. **是否可用**：对 HTTP 传输的 server 做一次可达性探测（`POST` 一个最小 JSON-RPC `initialize`，超时 3 秒）。连不上就跳过并报告原因。

**为什么两者都要**：「已配过」避免重复注册；「能用」避免注册一个坏 server 让模型反复超时。探测失败不阻塞搜索——它只是不注册那个 MCP。

**探测的代价**：每次 `hosts sync` 或宿主启动各一次，3 秒超时。可以缓存在 `~/.searchfuse/mcp-health.json`（带时间戳，5 分钟内复用）。

**关键设计：默认集合放在 `~/.searchfuse/config.json` 的 `mcp` 段**。

理由：这是共享层。用户在一处删掉 `grep`，三家都不会再注册它——不需要分别去三处删除。

**默认 MCP 不进 `CONFIG_TEMPLATE`**——这是既有测试钉住的规则（`config.test.ts:446`：

> 「a default written into the file would silently outrank a future change to it」
> 写进文件的默认值会静默压过未来的默认值变更。

正确做法：默认集合是**代码里的常量**，在读取配置时与用户 `mcp` 段合并：

```ts
const DEFAULT_MCP = {
  context7: { transport: 'streamable-http', url: 'https://mcp.context7.com/mcp' },
  grep:     { transport: 'streamable-http', url: 'https://mcp.grep.app' },
}

// effectiveMcp(config) = { ...DEFAULT_MCP, ...config.mcp }
//   用户写了同名 → 用户值胜出（可以改端点、可以 enabled: false 关掉）
//   用户没写 → 用默认（端点升级时自动跟随）
```

这样「缺则注册」成立，且默认值将来变化时用户能自动受益。

## 七、配置 schema

```jsonc
{
  "engine": "",
  "engines": { ... },
  "aggregate": { "mode": "rrf", ... },
  // MCP 覆盖。**留空即可**——默认值在代码里（DEFAULT_MCP）。
  // 只有想改端点或关掉某个时才写这一项。
  "mcp": {
    // "context7": { "transport": "streamable-http", "url": "https://自己的实例" }
    // "grep": { "enabled": false }   ← 关掉它
  },
  "hosts": {
    "dsh":        { "enabled": true },
    "claudeCode": { "enabled": true },
    "omp":        { "enabled": true }
  },
  // 仅 x_search/read_page 走 HTTP 时需要；默认不用。
  "serve": { "port": 0, "idleExitSeconds": 0 }
}
```

## 八、实施顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | `loadLayeredConfig`：三层深合并 | 单测：全局+项目+宿主三层，后者覆盖前者、缺失继承 |
| M1 | `DEFAULT_MCP` 常量 + `effectiveMcp()` 合并；`hosts sync` 三家各自补缺 | 用户不写也能拿到 context7/grep；写了覆盖默认；`config.test.ts:446` 仍通过（模板不含默认值） |
| M1·5 | MCP 双检测：是否已配 + 可达性探测 | 探测连不上的 server 不被注册；已配的不重复 |
| M2 | `omp/extension.ts`：同名覆盖 `web_search` | `omp -e ./omp/extension.ts -p "use web_search"` 命中我们的实现 |
| M3 | Claude 的 `tool.list` 移除 `WebSearch` + 注册 `mcp__searchfuse__web_search` | `claude plugin validate` 绿；真机验证模型只看到我们的 |
| M4 | dsh 保持现状，验证 MCP 默认集合生效 | 真机 `web_search` + `mcp__grep_*` 都可用 |

## 九、非目标

- Claude 保持 `WebSearch` 原名（宿主的 `$.tool.register` 强制前缀）

## 十、已知风险

| 风险 | 处置 |
|---|---|
| `tool.list` 的过滤依赖未文档化的内部形状（`{ value: [...] }`） | 已在 v2 实测；若宿主升级改变形状，`tool.list` 过滤会静默失效——加一条测试断言「`WebSearch` 不在最终列表里」 |
| Claude 工具改名后模型可能不适应 | 描述里写清「这是搜索工具」；`tool.list` 已移除原名，不存在歧义 |
| omp 扩展同名覆盖依赖宿主内部行为 | 已实测验证（`SHADOW_PROBE_HIT`）；若宿主升级破坏，`omp` 侧可退回 `web_search.enabled: false` + 注册新名 |
| `@searxng-js/searxng@0.1.3` 的 `win32-x64` 平台包不存在（上游发布缺口） | 钉在 `0.1.2`（三平台齐全）；若升级需先确认平台包版本对齐 |
| 内置实例的上游引擎在无代理网络下全部 timeout | 这正是 `searxng.outgoing.proxies` 要解决的问题；空配置时如实返回零结果并列 unresponsive |
| 默认 MCP 端点将来失效 | 用户在 `~/.searchfuse/config.json` 一处修改即可 |
| `grep`/`context7` 需要联网 | 失败时 MCP 客户端自行重试；不阻塞搜索 |
