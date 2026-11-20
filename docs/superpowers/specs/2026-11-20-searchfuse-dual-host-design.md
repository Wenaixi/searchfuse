# searchfuse 双宿主架构设计（dsh + Claude Code Mod）

> 状态：已确认，待实施
> 日期：2026-11-20
> 仓库：`E:\newCC\aaa-dsh-go\dsh-modsearch`（@wenaixi/searchfuse）

## 一、背景与目标

searchfuse 是一个多引擎聚合搜索工具，当前以 dsh 插件形态交付（`dsh/` 绑定 + `src/` 内核）。目标：**同一仓库同时产出 dsh 插件与 Claude Code Mod**，替换 Claude Code 原生 WebSearch/WebFetch，共享同一份配置，让用户在两个宿主获得一致的搜索能力。

三个探索子代理已完成事实查证：
- Mods 插件体系（`on('tool.call')` 拦截、原生 Shape 应答、`next(e)` 回退）——参考 `claude-code-templates` 的 `websearch-to-exa` 与 `webfetch-cache`
- searchfuse 内核迁移面：**80% 可直接复用**，需重写 transport（undici→`$.http.fetch`）、SSRF 层（dns→URL 黑名单）、fs 层（node:fs→`$.store`）
- SearXNG 内置：`@searxng-js/searxng`（Nuitka 单文件 23 MiB，Windows 官方支持），`$.process.spawn` 起常驻子进程
- `$.fs` 配置共享：**可行**（官方文档 + ultra-config 先例），`~` 不展开需 `$.env.get('HOME')` 拼绝对路径

## 二、已确认的设计决定

| # | 决定 |
|---|---|
| D1 | 单仓库双目录：`src/`（内核）+ `dsh/`（DSH 绑定）+ `claude/`（Mod 绑定）|
| D2 | `@searxng-js/searxng` 作为**生产依赖**（23 MiB 进包，DSH 用户也带）|
| D3 | dsh 绑定**全保留**，与 Mod 同步开发，不冻结不删 |
| D4 | 免费引擎默认全部聚合，`aggregate.mode: rrf \| chain`（与 dsh 同语义）|
| D5 | 退避模式：全局 `aggregate.mode` 开关，chain=严格串行，rrf=并发融合 |
| D6 | 引擎顺序：`engineOrder` 逗号分隔字符串，**anysearch 打头** |
| D7 | 拖动优先级 UI 在 **dsh 设置卡片**实现，写 `engineOrder` |
| D8 | x_search：`$.process.run(['searchfuse','-q',q,'--source','x'])` 复用 CLI（同 dsh 同构）|
| D9 | **不注册 read_page** 工具（与 WebFetch 功能重复），只替换 WebFetch |
| D10 | SearXNG **默认开**（装上就 spawn），二进制缺失优雅降级，会话预启动、空闲回收 |
| D11 | 配置共享：`$.fs` 读 `~/.searchfuse/config.json`（dsh 与 Mod 共用），mtime 热跟随 |
| D12 | 替换 WebSearch + WebFetch 两工具，失败均 `next(e)` 回退原生 |
| D13 | MCP 不自建客户端（Claude Code 原生支持 MCP 配置）|
| D14 | 测试：纯逻辑模块继续 vitest，hooks 层用 `claude plugin test` |

## 三、架构

```
searchfuse/
├─ src/                    # 纯 TS 内核（双宿主共用，80% 可复用）
│  ├─ aggregate/           # RRF / canonicalUrl / fanout（可直接移植）
│  ├─ providers/           # anysearch/tavily/exa/keenable/firecrawl/youcom/searxng
│  ├─ util/                # redact/apiKeys/host/errorCause/explicitProxy（纯函数可带）
│  └─ mcp/                 # 手写 MCP client（Mod 场景价值低，保留给 dsh）
├─ dsh/                    # DSH 宿主绑定（保留，含拖动优先级卡片）
├─ claude/                 # Claude Code Mod 绑定（新增）
│  ├─ .claude-plugin/plugin.json
│  ├─ hooks/register.ts    # WebSearch/WebFetch 替换 + x_search
│  ├─ engine/              # src 移植（transport 换 $.http.fetch + SSRF 层重写）
│  └─ searxng/             # SearXNG 管理器（@searxng-js）
└─ ~/.searchfuse/config.json   # 两宿主共享
```

### 数据流

```
dsh 卡片拖动 → 写 engineOrder 到 ~/.searchfuse/config.json
    → Mod session.start 读同一份 → mtime 热跟随

WebSearch 调用 → Mod hook → 读配置 + 引擎顺序
    → 融合：并发扇出 + RRF（含 SearXNG）
    → 按原生 Shape 返回（不调 next）
    → 全失败 → next(e) 回退原生

WebFetch 调用 → Mod hook → 引擎抓取（firecrawl/本地）+ 缓存
    → 返回 { result: string, context }
    → 失败 → next(e)
```

## 四、Claude Code Mod 细节

### 4.1 plugin.json

```json
{
  "name": "searchfuse",
  "version": "0.1.0",
  "description": "多引擎聚合搜索，替换原生 WebSearch/WebFetch",
  "userConfig": {
    "engineOrder": { "type": "string", "default": "anysearch,firecrawl,keenable,youcom,searxng,tavily,exa" },
    "apiKey": { "type": "string", "sensitive": true },
    "aggregateMode": { "type": "string", "default": "rrf", "options": ["rrf", "chain"] },
    "searxngEnabled": { "type": "boolean", "default": true },
    "cacheTtlSeconds": { "type": "number", "default": 300 }
  }
}
```

### 4.2 hooks/register.ts 结构

```ts
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  // 模块级缓存：配置 + 引擎状态
  let config: SearchfuseConfig | undefined

  on('session.start', async ($, e, next) => {
    config = await readSharedConfig($)   // $.fs 读 ~/.searchfuse/config.json
    startSearxngIfEnabled($)              // 会话预启动
    return next(e)
  })

  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    const result = await runFusedSearch($, e.query, config)
    if (result) return { result: toNativeShape(result, e) }
    return next(e)                        // 失败回退原生
  })

  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const cached = await readCache($, e.url)
    if (cached) return { result: cached, context: ['served from cache'] }
    const outcome = await next(e)         // 先让原生跑
    await writeCache($, e.url, outcome)
    return outcome
  })

  on('tool.call', { tool: 'x_search' }, async ($, e, next) => {
    // $.process.run 调 CLI
  })
}
```

### 4.3 引擎融合（search.ts 移植）

- 从 `src/search.ts` 的 `runFused` 移植：fanout → rrf → cache
- **transport 分层**（`claude/engine/http.ts`）：
  - `fetch`：默认路径，`$.http.fetch`（保留 headers/content-type/status/body；接受 30 秒固定超时；不保证代理）
  - `curlFetch`：特殊路径，`$.process.spawn(['curl', ...])`（`env.HTTPS_PROXY` 传代理、`--max-time` 传超时、`next.signal` 真取消）
  - 引擎配了 `proxy` 字段或需要短超时 → 自动走 curlFetch
  - **SearXNG 走 curlFetch**：本机 127.0.0.1 服务，`$.http.fetch` 对 localhost 可能直接拒绝
- SSRF 层：dns 预解析 → URL 黑名单（参考原 `http/network.ts` 的 `normalizeFetchUrl`）

### 4.4 SearXNG 管理器

```
启动：session.start 里 startServer()（$.process.spawn）
空闲：$.clock.after/every 60-120s stop() 回收
兜底：session.end kill
降级：启动失败 → 本次搜索不加 SearXNG，next(e) 不阻塞
```

## 五、dsh 侧改动

- `dsh/client.js` 设置卡片：**新增引擎顺序拖动 UI**（↑↓ 调整，写 `engineOrder`）
- `src/config.ts`：支持 `engineOrder` 字段（逗号字符串 → 数组解析）
- 保留能力矩阵（expose.aggregate/tool）不变

## 六、测试策略

| 层 | 框架 | 覆盖 |
|---|---|---|
| engine/ 纯函数 | vitest（搬现有）| RRF/canonical/fanout/redact/apiKeys |
| engine/ transport | vitest（mock $）| 各引擎 $ 适配、SSRF 黑名单 |
| hooks | `claude plugin test` | WebSearch 替换、WebFetch 缓存、失败回退 |
| searxng | 集成（真机）| spawn/健康/回收/降级 |
| dsh 卡片 | 现有 vitest | 拖动 UI 写 engineOrder |

## 七、验证

1. `npx vitest run`（现有 650 + 新增）全绿
2. `cd claude && npx -y -p typescript@5 tsc -p tsconfig.json` 类型干净
3. `claude plugin validate` + `claude plugin test`
4. 真机：`~/.searchfuse/config.json` 写 engineOrder → Mod 热跟随 → WebSearch 返回聚合结果
5. 降级：SearXNG 进程杀掉 → WebSearch 正常（不加 SearXNG）

## 八、非目标

- MCP 自建客户端（D13）
- read_page 工具（D9）
- 语言池并行、HTML SERP 引擎（延续之前决定）
- CI 简化不在本 spec 范围（已单独完成）