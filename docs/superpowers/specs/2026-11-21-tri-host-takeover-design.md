# 三宿主搜索接管与默认 MCP 设计

> 状态：待批准
> 日期：2026-11-21
> 仓库：`E:\newCC\aaa-dsh-go\dsh-modsearch`（`@wenaixi/searchfuse`）
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
| **Claude Code `tool.list` 钩子可移除工具** | 二进制原文 `tool.list hooks removed this tool`（**返回形状未实测**，M3 开工前必须先验证） |
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

## 四、三家如何接管

### 4.1 dsh（保持现状，已实现）

`cordis.patch.yml` 把 `searchProvider` 指向 `modsearch`。宿主原生的 `web_search` 工具名不变，**后端是我们**。

**这是真替换**：用户/模型看到的还是 `web_search`，实际跑的是 7 引擎聚合。

### 4.2 Claude Code

两条钩子，取代当前的「接管 + 回退」：

```ts
// 1. 移除内置 WebSearch —— 模型看不到它
//    ⚠️ 未验证：`next(e)` 返回什么形状、能否过滤，M3 的第一步是实测这个
on('tool.list', async ($, e, next) => {
  const list = await next(e)   // 形状待确认
  return { ...list, tools: list.tools.filter(t => t.name !== 'WebSearch') }
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

## 五、随机端口与保活

**每家 spawn 自己的 `kernel.js` 实例**。

| 要求 | 如何满足 |
|---|---|
| 随机端口 | 不监听端口——`kernel.js` 是子进程，通过 stdin/stdout 交换 JSON |
| 自动检测 | 子进程起不来 → 返回明确错误；宿主自己决定怎么展示 |
| 自动保活 | 子进程随宿主的调用起灭，不需要守护进程 |

**为什么不用 HTTP 服务**：omp 的 `searxng.endpoint` 是静态字符串。要让它跟随随机端口，得每次端口变化重写 omp 配置——那就回到「固定端口」或「用户手动跑命令」，两个都不要。

`src/serve.ts` 保留，但**不再作为三家共用的执行点**——它只用于 omp 的 `x_search`/`read_page`（那些走 MCP 通道的场景，可选）。

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

**关键设计：默认集合放在 `~/.searchfuse/config.json` 的 `mcp` 段**。

理由：这是共享层。用户在一处删掉 `grep`，三家都不会再注册它——不需要分别去三处删除。

**`initConfigFile` 要写入默认 MCP**（现在 `CONFIG_TEMPLATE` 里没有）。

## 七、配置 schema

```jsonc
{
  "engine": "",
  "engines": { ... },
  "aggregate": { "mode": "rrf", ... },
  // 默认 MCP 集合。缺则三家各自注册；删掉某项就是三家都不要。
  "mcp": {
    "context7": { "transport": "streamable-http", "url": "https://mcp.context7.com/mcp" },
    "grep":     { "transport": "streamable-http", "url": "https://mcp.grep.app" }
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
| M1 | `CONFIG_TEMPLATE` 加默认 MCP；`hosts sync` 三家各自补缺 | `init` 后配置含默认 MCP；对已有配置不覆盖 |
| M2 | `omp/extension.ts`：同名覆盖 `web_search` | `omp -e ./omp/extension.ts -p "use web_search"` 命中我们的实现 |
| M3 | Claude 的 `tool.list` 移除 `WebSearch` + 注册 `mcp__searchfuse__web_search` | `claude plugin validate` 绿；真机验证模型只看到我们的 |
| M4 | dsh 保持现状，验证 MCP 默认集合生效 | 真机 `web_search` + `mcp__grep_*` 都可用 |

## 九、非目标

- omp 走 SearXNG 路由（随机端口下不可行，已证）
- 三家共用一个 HTTP 服务进程（omp 的静态 endpoint 做不到）
- Claude 保持 `WebSearch` 原名（宿主的 `$.tool.register` 强制前缀）

## 十、已知风险

| 风险 | 处置 |
|---|---|
| **M3 的 `tool.list` 过滤形状未验证**——若返回的不是可过滤的数组，Claude 侧就无法移除内置 `WebSearch`，该阶段需改方案 | M3 开工前先跑探针确认；若不可行，退回「`tool.call` 拦截 + 改名注册」 |
| Claude 工具改名后模型可能不适应 | 描述里写清「这是搜索工具」；`tool.list` 已移除原名，不存在歧义 |
| omp 扩展同名覆盖依赖宿主内部行为 | 已实测验证（`SHADOW_PROBE_HIT`）；若宿主升级破坏，`omp` 侧可退回 `web_search.enabled: false` + 注册新名 |
| 默认 MCP 端点将来失效 | 用户在 `~/.searchfuse/config.json` 一处修改即可 |
| `grep`/`context7` 需要联网 | 失败时 MCP 客户端自行重试；不阻塞搜索 |
