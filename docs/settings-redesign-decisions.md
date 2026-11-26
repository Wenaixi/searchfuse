# searchfuse 设置界面重设计 — 完整决策清单

> 用途：把这份文档交给更强的模型审阅，逐条给出裁决。
> 每条都附「已核实的事实」与「候选方案」，不需要读者再去查证任何东西。

---

## 零、背景：这个界面是什么

- **产品**：`@wenaixi/searchfuse`，一个 dsh 插件，提供融合搜索（并发询问多个搜索引擎，按 RRF 融合结果）、X 搜索、单页抓取。
- **界面位置**：dsh Web 端的「插件」页 → 点某个插件 → 该插件自己的配置区（插槽名 `plugins.bundle.config`）。
- **用户**：技术用户（要配 API 密钥、代理、上游引擎）。
- **当前状态**：功能完整但视觉与信息架构被用户评价为「丑、不人性化」。
- **约束**：不能改宿主，只能用宿主提供的组件与 CSS 变量。

---

## 一、已核实的硬事实（全部有证据，不需要复核）

### F1. 宿主主题 token 在 `body` 上，共 354 个

```js
getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary')  // "#f9fafb"
getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-label-primary')  // ""
```

关键 token 实测值：

| token | 实测解析值 |
| --- | --- |
| `--dsw-alias-label-primary` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `#adb2b8` |
| `--dsw-alias-card-fill` | `rgb(33,33,35)` **不透明** |
| `--dsw-alias-bg-layer-1/2/3` | `color(srgb ... / 0.28~0.29)` **半透明混色** |
| `--dsw-alias-bg-module-platform` | 同上，半透明 |
| `--dsw-alias-border-l4` | `rgba(180,180,180,0.35)` |
| `--dsw-radius-sm` / `--dsw-radius-md` | `8px` / `12px` |
| `--dsw-elevation-soft` | `0 0 0 .5px rgba(180,180,180,0.35), 0 4px 16px #00000008, 0 0 24px #00000008` |
| `--dsw-alias-state-success-primary` | `#22c55e` |
| `--dsw-alias-state-business-primary` | `color-mix(#4f8cff 45%, #fff)` |
| `--dsw-focus-ring-width` | `2px` |
| `--dsw-focus-ring-color` | **空（不存在）** |

注：`bg-layer-*` 是 `color-mix` 生成的半透明色，会跟随主题基色（本机主题把它染成青绿）。需要不透明底时必须用 `card-fill`。

### F2. 官方客户端原子组件目录（从 50+ 个官方 `dsh-client-ui-*` 包的源码 grep 得出）

按使用次数排序的非图标组件：

```
Button(168) Tooltip(96) StateDot(45) Modal(33) Tag(32) Menu(27) Toast(25)
DisclosureRow(13) MarkdownText(12) MenuItemButton(9)
SettingsValueField(8) Switch(7) Input(7) Checkbox
settingsNumberField(6) settingsTextField SettingsFormModel
Pill HoverCard MenuSurface MenuGroup PathLabel InlineEditor ShortcutKeys
SettingsForm SettingsSecretField ConnectionIndicator
```

无物理包：primitive 由运行时模块加载器提供，插件内 `require("@deepseek-ai/dsh-client-ui-primitives")` 即可。

### F3. 官方组件真实 props 契约（从官方包源码中的调用点反推）

```js
SettingsForm      { labels:{unavailable,readOnly,saveFailed,save,saving},
                    state, onSave, onDiscard, children }
SettingsValueField{ id, label, hint, overriddenLabel, resetLabel, invalidLabel,
                    numeric, disabled, value, onEdit, onReset, help, invalid }
SettingsFormModel (scope, [settingsTextField(name) | settingsNumberField(name)])
Switch            { checked, label(必填), onChange, disabled, title, className }
Tag               { tone: neutral|solid|outline|success|info|warning|danger, children }
StateDot          { state: done|warning|ongoing|error|idle, size, appearance }
Button            { variant: primary|ghost|outline|toolbar, size: md|sm, onClick, disabled, children }
DisclosureRow     { title, icon, open, expandable, expandOnRowClick,
                    keepContentWhenOpen, onToggle, onExpand, className, rowClassName }
Input             { ref 指向原生节点, type, value, placeholder, onChange, ... }
Checkbox          { checked, label, onChange, disabled }
```

`SettingsForm` 是**纯受控展示组件**，只吃上面五个 props，不依赖任何服务。所以「插件走自己的 HTTP 路由读写配置」仍然可以用它（不需要 `ctx.settings` / `configForms`）。

### F4. 官方设置面板的既定形态（从在跑的官方风格插件源码得出）

```js
// 根容器：无背景、无边框，只靠 gap 与分段下边线
{ display:'flex', flexDirection:'column', gap:'16px', maxWidth:'720px' }
// 每个分段
{ gap:'12px', paddingBottom:'16px', borderBottom:'1px solid var(--dsw-alias-border-l2)' }
// 段标题 13px/600；段说明 12px/label-tertiary/1.5
// 每行自持底色
{ padding:'8px 10px', borderRadius:'var(--dsw-radius-sm)', background:'var(--dsw-alias-bg-layer-1)' }
// 行内左侧文字两行：name 13px/label-primary、desc 12px/label-tertiary + ellipsis
// 行右侧放官方原子控件（Switch / Tag / StateDot / Button）
// 页脚 { display:'flex', justifyContent:'space-between', gap:'12px' }
```

官方原话（该插件源码注释）：**「只做布局，不定义视觉：颜色与形状一律交给 DSH 官方组件与 CSS 变量」**。

### F5. 内置 SearXNG 的真实规模

本机解包实例 `settings.yml` 实测：

- 上游引擎总数 **352**
- 默认禁用 **231**
- 默认启用 **121**

### F6. 现有后端 API 形状

| 端点 | 返回 |
| --- | --- |
| `GET /searchfuse/config` | `{ engine, engines:{name:{baseURL,model,hasKey,keySource,enabled,defaultOff,expose,proxy,toolName}}, keyed[], endpoints[], models[], mcp:{name:{url,transport,proxy,enabled,isDefault}}, searxng:{embedded,outgoing,networks,engines} }` |
| `POST /searchfuse/config` | 接受 patch，返回同上 |
| `GET /searchfuse/config?doctor=1` | 额外 `readiness:[{engine, ready, reason, fix}]` |
| `GET /config` | `{ engines:[...] }`（omp 用） |

**没有**「SearXNG 实例是否在运行 / 端口 / 启动耗时」这类运行时状态。

### F7. 现有可配置字段全集（来自 `src/config.ts`）

顶层：

```ts
engine?: string                    // 首选引擎，'' = 自动
engines?: Record<string, EngineSettings>
aggregate?: AggregateConfig        // { mode:'rrf'|'chain', deadlineMs }（缓存已移除，无 cacheTtlMs）
mcp?: Record<string, McpServerConfig>
cooldown?: string                  // 'on' | 'off'
allowPrivateNetwork?: boolean
hosts?: { dsh?, claudeCode?, omp? } // 每个宿主是否接入
serve?: { port?, idleExitSeconds? }
searxng?: SearxngConfig
```

`EngineSettings`：

```ts
apiKey?, model?, bin?, enabled?, keylessFetch?, baseURL?, proxy?,
expose?{aggregate,tool}, toolName?, embedded?（派生字段，不写文件）
```

`SearxngConfig`：

```ts
embedded?, extra_proxy_timeout?,
outgoing?: { http?|https?|'all://'?: string|string[] },
networks?: Record<name, { proxies? }>,
engines?: Record<name, { network?, proxies?, using_tor_proxy?, disabled? }>
```

### F8. 引擎清单（9 个，按性质天然分三组）

| 引擎 | 性质 | 是否需要密钥 | 说明 |
| --- | --- | --- | --- |
| antigravity-cli | 本地命令行 | 否（要装要登录） | 需 `agy` 二进制 |
| grok-cli | 本地命令行 | 否（要装要登录） | 仅 X 搜索 |
| tavily | 云端 API | **是** | |
| exa | 云端 API | **是** | |
| firecrawl | 云端 API | 否（有免注册额度） | |
| keenable | 免注册额度 | 否 | |
| anysearch | 免注册额度 | 否 | |
| youcom | 免注册额度 | 否 | 每 IP 每天 100 次 |
| searxng | 自带实例 / 外部实例 | 否 | 见 F5 |

### F9. 保存模型的开源共识（多源交叉验证）

| 来源 | 结论 |
| --- | --- |
| GitHub Primer | 「一个页面不要混用显式保存与自动保存」；**表单默认从显式保存开始** |
| GitLab Pajamas | 自动保存适合长表单且保存按钮被推到折叠线以下的情形 |
| Gutenberg | 「每个 surface 只能选一种保存模型」 |
| Borneo / Nubisco | 「一个 section 只能有一种保存模型」 |
| fractional-cto | 开关即时写、文本用显式保存，**但不在同一表单混用** |
| threshline | 「设置最常见的错误是按系统架构组织，而不是按用户意图」 |

`SettingsForm` 外壳自带 `onSave` / `onDiscard`，即**官方认定的显式保存模型**。

### F10. 本机运行环境

- 宿主加载插件的真实路径是 profile 里 pnpm 的**安装时快照副本**，不是仓库。
  改完源码必须：`vite build` → `dsh plugin --profile web add "<仓库>"` → 完全重启宿主 → 用字节数比对确认。
- 宿主当前启用壁纸引擎，页面祖先链全透明，壁纸不在 DOM 里（`backdrop-filter` 无可模糊内容）。
- 宿主是 dark-only：正文 `rgb(249,250,251)`。

---

## 二、待裁决的决策（每条含候选与我的倾向）

### D1. 121 个默认启用的上游引擎，全展开怎么渲染？

**事实**：352 个引擎，121 个默认启用。官方 primitives **没有虚拟列表组件**（F2 清单里没有）。`dsh-chunked-list` 是持久化列表工具，不是 UI 虚拟滚动。

全部展开 121 行，每行若 3 个控件 = 363 个交互元素，页面高度约 4000px+。

- **A**：121 行直接渲染 + 顶部一个过滤输入框（按名字过滤）。不引虚拟滚动。
- **B**：默认只显示「已启用」的（121 行），加一个「显示全部 352」的展开开关。
- **C**：自建虚拟滚动（需自己实现，违反「不自绘」原则）。
- **D**：改成按类别折叠（新闻/图片/百科/代码/购物…），每类一个 `DisclosureRow`。

**我的倾向：B**。理由：默认只看「在用的 121 个」，需要时再放开到 352；既满足「全部展开」的诉求，又不让首屏变成 4000px。

---

### D2. 上游引擎每行要放几个控件？

逐引擎代理是 SearXNG 的核心能力，但代理 URL 很长（`socks5h://user:pass@host:port`）。

- **A**：每行只有 `Switch`（启用/禁用），代理统一在段落上方的「默认代理」里配。
- **B**：每行 `Switch` + 一个代理输入框（两控件，行高约 56px）。
- **C**：每行 `Switch`，代理放在「展开这一行」后（与「全部展开」矛盾）。
- **D**：`Switch` + 代理 + Tor 开关 + 禁用 四控件。

**我的倾向：B**。理由：逐引擎代理是这个功能存在的理由；A 把它降级成全局，失去精确控制；D 一行挤四个控件，在 720px 下会换行。

---

### D3. 内置实例的开关，即时生效还是等保存？

**事实**：拉起内置实例实测 1.1–1.4 秒（冷启动要解压原生包）。`Switch` 若即时保存，用户会看到 1.4 秒的空窗。

- **A**：即时生效，开关旁显示 `StateDot state="ongoing"` + 「启动中」，完成后变 `done`。
- **B**：跟随整页显式保存，点保存后一起提交（与 F9 的「一个 surface 一种模型」一致）。
- **C**：即时生效但不显示等待态（点了就走，后台起）。

**我的倾向：B**。理由：F9 明确「不要在同一 surface 混用两种保存模型」，而整页其他字段都是显式保存。A 会让同一页出现两种模型。

**这条与用户「SearXNG 默认启动」的诉求不冲突**：默认值已经在配置里是开，开关只是改这个默认值。

---

### D4. 「SearXNG 运行中」这个状态要不要显示？怎么拿？

**事实**：现有 `/searchfuse/config` 不返回运行时状态（F6）。要显示必须改后端。

- **A**：不显示运行时状态。状态区只显示「已配置/未配置」这类静态事实。
- **B**：新增后端字段 `searxngRuntime: { running, port, startedAt }`，前端轮询或随 config 一起返回。
- **C**：前端另外调 `/healthz` 判断。

**我的倾向：A**（首版）。理由：YAGNI——「是否运行中」对「配置对不对」没有决定作用，配置页回答的是「我配了什么」，不是「进程在不在」。若后续要做实例管理页，再加 B。

---

### D5. `engines.searxng` 这一项要不要在「引擎」列表里出现？

用户要求内置与外部 SearXNG **独立成段**（不是引擎列表里的一项）。

- **A**：不出现在引擎列表；内置段有「启用内置实例」开关，外部段有 `baseURL`。两者都空 = searxng 不参与。
- **B**：仍出现在引擎列表（可开关），同时另有独立配置段。
- **C**：不出现在引擎列表，也不给开关（永远参与）。

**我的倾向：A**。理由：B 会让同一个东西在两处出现，用户改了这处不知那处为何没变；C 剥夺了「不用它」的能力。

---

### D6. 老宿主（可折叠卡片槽）与新宿主（page 视图）共用一套结构吗？

- **A**：共享同一份「段落定义」数据结构，只有外壳不同（新宿主无卡片、老宿主折叠）。
- **B**：两套各写一份渲染代码。
- **C**：老宿主直接复用新宿主的分段布局，只是外面套一个折叠。

**我的倾向：C**。理由：分段布局在窄容器里同样成立；A 多一层抽象（YAGNI 反对）；B 必然漂移。

---

### D7. 保存失败要不要定位到具体字段？

**事实**：现有 `POST /searchfuse/config` 失败只返回 `{error: "一句话"}`（F6）。后端校验已有（`validateSearxngSection` 等）。

- **A**：保持整页一句话失败消息（页脚 `role="alert"`）。
- **B**：后端返回 `{error, field}`，前端滚动到该字段并高亮。
- **C**：后端返回 `{errors:[{field,message}]}`，页脚列出全部。

**我的倾向：A**（首版）。理由：B/C 要改后端契约，而当前配置字段不多、错误多是「地址格式」这种用户能自己看出来的；等真出现「改了 A 却报 B」再加。

---

### D8. 引擎分组标题用什么词？

F9 的 threshline 明确指出「按用户意图，不按系统架构」。

- **A**：`云端 API（需密钥）` / `免注册额度` / `本地工具`
- **B**：`需要 API 密钥` / `开箱可用` / `需要安装`
- **C**：`已就绪` / `未就绪`（按状态）
- **D**：不加分组标题，用一个平铺列表

**我的倾向：B**。理由：A 里「云端 API」是架构词；B 直接回答「我要做什么才能用它」，正好是用户的心理问题。

---

### D9. 状态总览（第一段）具体显示什么？

- **A**：三枚 `StateDot` + 文字：「N 个引擎可用 / SearXNG 已启用 / M 个 MCP 已连接」
- **B**：一句话结论 + 一枚 `Tag`：「可以搜索」/「还缺密钥」
- **C**：完整小表，逐引擎列状态（等于把引擎段复制一遍）

**我的倾向：A**。理由：B 太粗（用户想知道细节时还得往下找）；C 重复。

---

### D10. 面板宽度与字号

- **A**：`max-width:720px`；字号 15/13/12 三档
- **B**：`max-width:560px`；字号 14/13/12
- **C**：占满容器；字号 15/13/12

**我的倾向：A**。理由：720px 是官方实测值；560px 会让代理 URL 换行。

---

### D11. 「全部展开」是否包括 MCP 与 SearXNG？

- **A**：三块全部常显
- **B**：引擎全展开，MCP 与 SearXNG 按需展开
- **C**：引擎与 MCP 全展开，SearXNG 因规模大用折叠

**我的倾向：A**（用户已明确要），但 **D1 的规模问题**会让 SearXNG 段极长，需 D1 先定。

---

### D12. 密钥字段是否用官方 `SettingsSecretField`

**事实**：F2 里有 `SettingsSecretField`，但官方调用样例只有 2 处，契约未完全读出。

- **A**：用 `SettingsSecretField`（若契约不确定则退回 `SettingsValueField` + `type=password`）
- **B**：一律用 `SettingsValueField`，密钥靠 CSS `-webkit-text-security:disc`
- **C**：用原生 `Input` + `type=password`

**我的倾向：A**，并在实现前先读出它真实契约；读不出则 B（这也是当前实现的做法，且已有测试覆盖）。

---

### D13. 引擎块的「块」用什么承载？

- **A**：每引擎一个 `.sf-row`（`bg-layer-1` + `radius-sm`），块内纵向排列字段
- **B**：每引擎一张卡片（`card-fill` 实底 + `elevation-soft`）
- **C**：无块，用 `border-bottom` 分隔每个引擎

**我的倾向：A**。理由：与官方行块语言一致；B 的实底卡片会与「无卡片」的整页语言冲突。

---

## 三、需要外部裁决的三个元问题

### M1. 「全部展开」与「352 个引擎」在物理上冲突，优先保哪个？

用户原话「都要展开」。但 121 行 × 每行 2 控件 = 242 个元素，页面 4000px+。
要么牺牲「全部」（D1-B 默认只看启用中的），要么牺牲简洁。**这是本设计最大的取舍点。**

### M2. 「一个 surface 一种保存模型」是否允许「实例开关」例外？

F9 明确反对混用。但「开关」在大多数产品里是即时生效的。要么整页统一显式保存（开关也等保存），要么为开关破例。

### M3. 官方 primitives 是否够用，还是必须自绘？

F2 清单里**没有**：行容器、可展开的详情面板、带说明的单选组、过滤器输入框。
官方做法是「布局自己写，控件用官方」——但这意味着我仍要写约 10 个只有布局的 CSS 类。**这算不算「自绘」的边界？**

---

## 四、我打算采用的最终方案（若无人否决）

```
搜索与抓取                                  ← 15px/600

● 3 个引擎可用   ● SearXNG 已启用   ● 2 个 MCP     ← 状态段

──────────────────────────────────────
引擎
  需要安装
    ┌ antigravity-cli  [Tag 未就绪]        [Switch] ┐
    └─ 密钥(如适用) / 端点 / 模型 / 代理 / 露出形态 ┘
  需要 API 密钥
    ┌ tavily  [Tag 已存密钥]              [Switch] ┐
    ┌ exa                                    ...
  开箱可用
    ┌ firecrawl / keenable / anysearch / youcom ...

──────────────────────────────────────
MCP 服务
    ┌ context7  [Tag 默认]                [Switch] ┐
    └─ 地址 / 代理                                ┘

──────────────────────────────────────
内置 SearXNG                           [Switch]
  默认只看启用的上游引擎（121），顶部过滤框 + 「显示全部 352」
    ┌ google    [Switch] [代理] ┐
    ┌ brave     [Switch] [代理] ┐
    ...
  默认代理（作用于未单独配置的引擎）

──────────────────────────────────────
外部 SearXNG
  地址 / 代理

──────────────────────────────────────
                      [放弃修改]  [保存]
```

---

## 五、实施约束（不可违反）

1. 每次改动后：`vite build` → `dsh plugin --profile web add "<仓库>"` → 重启 → **字节数比对**确认加载。
2. 所有颜色只用 `--dsw-*` token，零硬编码色值。
3. 描边用 `0.5px`（官方 9 处均为 0.5px）。
4. 可交互元素必须有 `:focus-visible`（`2px solid state-business-primary`）。
5. 测试先行：每改一块先写可失败断言。
6. 全量测试必须 730 通过。
