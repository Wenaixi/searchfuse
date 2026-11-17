# 配置 SearchFuse

用户问怎么装 searchfuse、要加 key、要换引擎，或者遇到配置类的失败时，读这份文档。直接替用户把命令跑了，不要把说明贴给对方。

## 心智模型

三件工作，称为角色（role）。每个角色有能干这活的引擎：

| 工作 | 引擎 | 可配置吗 |
| :-- | :-- | :-- |
| 搜公开网页 | `firecrawl`、`keenable`、`youcom`、`antigravity-cli`、`tavily`、`exa` | 首选引擎加每引擎参与开关 |
| 读一个 URL | 首选引擎（若它能抓取），然后是 `firecrawl`、`antigravity-cli`、`local` | 每引擎参与开关 |
| 搜 X（推特） | `grok-cli` | 每引擎参与开关 |

搜索顺序固定为 `firecrawl`、`keenable`、`youcom`、`antigravity-cli`、`tavily`、`exa`。抓取顺序是 `firecrawl`、`antigravity-cli`、`local`。每个引擎默认都参与。`engines.<name>.enabled: false` 会先排除一个引擎，可用性再过滤剩余名单，额度冷却最后重排就绪链（见下文）。Firecrawl 领跑两条链，因为它的免注册通道在裸机上就能用，不要账号不要 key。Keenable 排搜索第二也是同样的理由：Firecrawl 额度用完时，裸机上还有一个免注册的后备。You.com 排第三：额度更小的免注册通道（每个 IP 每天 100 次），给前两个都用完的繁忙 IP 兜底。

从这张表能推出两个事实，它们回答大多数问题：

- **单页抓取零配置可用。** `local` 引擎零安装，默认是抓取的最后兜底。只有用户明确禁用它时才会离开自动链。
- **网页搜索可在 Firecrawl 免注册免费额度上运行**（每月 1,000 credits，无需注册），后面还有 Keenable 的免注册额度（每个 IP 每小时 1,000 次）和 You.com 的免注册搜索（每个 IP 每天 100 次）。配置了 `engine` 时以配置为准。搜索链不含 `local`，因为 `local` 不能搜索。三个免注册引擎都被限流时，搜索至少还需要一个带 key 的引擎或 `agy` 作为后备。抓取仍有 `local` 兜底。

X 是独立语料，不是竞争的搜索引擎，所以它永远不会顶替网页搜索。`--source` 选语料，`--engine` 选工具。

## 零配置

searchfuse 没有配置文件也能跑：抓取有 `local` 兜底，搜索先走 Firecrawl 的免注册免费额度，再走 Keenable 的，再走 You.com 的。搜索没有 local 后备（`local` 不能搜索），所以三个免注册引擎都被限流时需要一个带 key 的引擎或 `agy`。它看这台机器上有什么，用最好的那个。只有用户想改变这一点时才需要建配置。

首选的免费升级是 Antigravity CLI，它写带引用的综述，一个工具同时覆盖搜索和抓取，还不要 key：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # 用户在浏览器完成登录后退出
```

登录没法自动化，请用户本人跑一次 `agy`。

## 配置文件

`~/.searchfuse/config.json`，写入时权限 0600，展示时 key 打码。优先级：CLI 参数 > 环境变量 > 这个文件 > 内置默认值。

```bash
searchfuse config init     # 生成起步文件，每个字段都可省略
searchfuse config show     # 生效配置：文件与环境变量合并，每个值标注来源 (file)/(env)，key 打码，别名归一显示
```

完整结构。每个字段都可省略，文件本身也可省略：

```json
{
  "engine": "tavily",
  "cooldown": "on",
  "allowPrivateNetwork": false,
  "engines": {
    "antigravity-cli": { "bin": "agy", "model": "gemini-3.8-flash-low" },
    "tavily":          { "apiKey": "tvly-...", "baseURL": "https://gw.example.com/tavily" },
    "exa":             { "apiKey": "...", "enabled": false },
    "firecrawl":       { "apiKey": "fc-...", "keylessFetch": false },
    "keenable":        { "apiKey": "..." },
    "grok-cli":        { "bin": "grok" }
  }
}
```

JSON 不支持注释，所以每个字段的说明在这里：

| 字段 | 类型 | 作用范围 | 含义 |
| :-- | :-- | :-- | :-- |
| `engine` | string | 顶层 | 由哪个引擎搜索。空表示自动（用本机可用的最好那个）。取值 `antigravity-cli`、`tavily`、`exa`、`firecrawl`、`keenable`、`youcom`、`searxng`、`arxiv`、`grok-cli`、`local` 之一。别名 `agy`、`antigravity`、`grok`、`http`、`direct` 也接受，会归一为正式名。 |
| `cooldown` | `"on"` / `"off"` | 顶层 | 额度冷却故障转移。默认开。关掉后不读不写任何状态，路由与从前完全一致。 |
| `allowPrivateNetwork` | boolean | 顶层 | 允许本地抓取器访问私有或保留地址，包括 VPN 使用的其他保留地址段和 hosts 文件加速器。默认 `false`。DNS 返回的 `198.18.0.0/15` 地址已按 fake-ip 占位值放行，无需此开关。在 URL 中直写该地址段，开关关闭时仍会被拦截。此设置从不授权 Firecrawl 云端披露，URL 中直写的私有和保留目标始终不会发往云端。对于 DNS 结果，只有应用 fake-ip 例外后所有地址仍被判为私有或保留地址时，Firecrawl 才会拒绝披露。 |
| `aggregate` | object | 顶层 | 融合搜索。开启时 `web_search` 并发询问多个引擎并合并它们的排序列表，而不是逐个尝试。详见下方「融合搜索」一节。 |
| `aggregate.mode` | `"rrf"` / `"chain"` | 顶层 | `rrf`（默认）并发扇出到每个合格引擎，用倒数排名融合。`chain` 恢复到融合之前的串行回退：一次试一个，先能用的那个胜出。 |
| `aggregate.deadlineMs` | number | 顶层 | 整轮融合运行的墙钟预算，含所有引擎。慢引擎不能把整轮拖过这个上限。这一个值被两个界面共用，所以设在这里的数同时管着 CLI 与面向模型的工具。未设置时的回落值两边不同：CLI 是 `8000`，dsh 插件下是 `55000`——那里的调用方是一个正在等模型回答的人。部署方设了插件自己的 `providerDeadlineMs` 时，它优先于文件。 |
| `aggregate.cacheTtlMs` | number | 顶层 | 一份融合答案在磁盘上可复用的时长。默认 `300000`（五分钟）。`0` 关掉缓存，这也是强制重新跑一遍的官方办法。 |
| `mcp` | object | 顶层 | 要桥接成工具的 MCP 服务端，按服务端名分组。详见下方「MCP 服务端」一节。 |
| `mcp.<server>.transport` | `"streamable-http"` | `mcp` | 唯一支持的传输方式。Streamable HTTP，不是 stdio。 |
| `mcp.<server>.url` | string | `mcp` | 服务端的 MCP 端点。 |
| `mcp.<server>.enabled` | boolean | `mcp` | 省略表示启用。`false` 保留条目但不连接。 |
| `mcp.<server>.headers` | object | `mcp` | 附加的请求头，供需要自己那套凭据头的服务端使用。 |
| `mcp.<server>.timeoutMs` | number | `mcp` | 同时是握手超时与单次调用超时。默认：握手 `10000`，调用 `30000`。 |
| `engines` | object | 顶层 | 按引擎正式名分组的每引擎设置。 |
| `engines.<name>.enabled` | boolean | 所有引擎 | 是否允许自动路由使用该引擎。省略表示启用，但下方「需要你打开才生效」一节列出的引擎除外。设为 `false` 会排除它，设为 `true` 会删除覆盖并回到内置默认。单次显式 `--engine` 仍会强制使用该引擎。 |
| `engines.<name>.apiKey` | string | `tavily`、`exa`、`firecrawl`、`keenable` | 一个 API key，或用英文逗号分隔的多个 key。解析时会忽略空白和空项。鉴权、限流或配额失败时按顺序轮换 key。网络、5xx 或解析失败时直接切换下一个引擎。也可用环境变量 `TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY` / `KEENABLE_API_KEY`，环境变量优先于文件。 |
| `engines.<name>.baseURL` | string | `tavily`、`exa`、`firecrawl`、`keenable`、`searxng` | 替换官方主机的接口地址：兼容的第三方网关、代理、自建部署。必须是完整的 http(s) URL。对 `searxng` 而言这就是实例地址，因为它没有官方主机。也可用环境变量 `TAVILY_BASE_URL` / `EXA_BASE_URL` / `FIRECRAWL_BASE_URL` / `KEENABLE_BASE_URL`。设为空即取消。详见下方端点一节。 |
| `engines.<name>.proxy` | string | 所有引擎 | 只让这个引擎走它自己的代理。留空则像以前一样跟随本机的 `http_proxy` / `https_proxy` / `no_proxy`。`direct` 或 `none` 表示仅此引擎绕过系统代理。完整的 `http(s)://` URL 表示这个引擎的流量走它。既不是关键字、也不是完整 http(s) URL 的值会被拒绝而不是忽略——回落到环境变量会把手误出来的笔误悄悄送进你正想避开的那个代理。 |
| `engines.<name>.expose` | object | 所有引擎 | 这个引擎如何参与搜索。两个键默认都是 `aggregate: true, tool: false`，这也是在这些设置出现之前写下的配置所得到的行为。详见下方「能力矩阵」一节。 |
| `engines.<name>.expose.aggregate` | boolean | 所有引擎 | 这个引擎的结果是否进入融合后的 `web_search` 答案。`false` 表示它只做独立工具。 |
| `engines.<name>.expose.tool` | boolean | 所有引擎 | 这个引擎是否同时成为一个可按名调用的独立工具。两个开关可以同时打开。 |
| `engines.<name>.toolName` | string | 开了 `expose.tool` 的引擎 | 模型看到的那个独立工具名。默认 `<engine>_search`。两个引擎不能同名，内置工具名是保留的。 |
| `engines.firecrawl.keylessFetch` | boolean | `firecrawl` | 允许 Firecrawl 在无 key 时抓取公网页面。默认 `true`（免注册抓取开箱即开）。设为 `false` 可让自动抓取远离 Firecrawl 云端。配置了 key 或显式选择 Firecrawl 引擎时仍会启用。 |
| `engines.<name>.bin` | string | `antigravity-cli`、`grok-cli` | 该引擎 CLI 的路径。默认在 `PATH` 上找 `agy` 和 `grok`。 |
| `engines.<name>.model` | string | `antigravity-cli` | 引擎使用的模型。默认 `gemini-3.8-flash-low`。 |

`local`（内置抓取器）和 `grok-cli` 不需要凭据，但都接受通用的 `enabled` 开关。老文件把 `allowPrivateNetwork` 存在 `engines.http.allowPrivateNetwork` 下，或存成字符串 `"true"`/`"false"` 的，读取时会自动提升为顶层布尔值。

```bash
searchfuse config set engine tavily            # 选定搜索引擎
searchfuse config set engine ""                # 回到自动
searchfuse config set tavily.apiKey <key>      # 引擎凭据
searchfuse config set tavily.apiKey <key1,key2> # 按此顺序轮换 key
searchfuse config set tavily.apiKey            # 不带值：隐藏输入提示（见下）
searchfuse config set tavily.baseURL <url>     # 兼容的第三方端点
searchfuse config set tavily.enabled false     # 不让 Tavily 参与自动故障转移
searchfuse config set tavily.enabled true      # 删除禁用覆盖
searchfuse config set cooldown off             # 关闭额度冷却故障转移
searchfuse config set allowPrivateNetwork true # 允许访问保留/私有地址段
```

用户要往对话里贴 key 时，先给更干净的路径：让用户在自己的终端跑不带值的
`searchfuse config set <engine>.apiKey`，CLI 会弹出不回显的输入提示，key 不进这
个对话、不进 argv、不进 shell 历史（`pbpaste | searchfuse config set
tavily.apiKey` 管道喂入也行）。用户还是直接贴进对话的话，照常替他保存：这个选
项是给在意的人的，不是一道门。

通用 `enabled` 开关同时作用于搜索、抓取和 X。抓取先用能抓取的首选引擎，再按内置顺序尝试已启用的引擎。禁用 `local` 会移除默认抓取兜底。禁用 `grok-cli` 会让 X 请求走文档约定的公开网页降级路径。单次显式 `--engine` 不受这些持久化禁用项影响。

角色概念出现之前写的配置（一个全局 `provider` 加一个 `providers` 表）会被自动读取并映射，不用手动迁移。

## 引擎设置

### antigravity-cli（搜索 + 抓取，免费，无 key）

按上文安装并登录。它的免费额度是与 Antigravity 桌面应用和 SDK 共享的每周配额，重度使用的一天可能把它耗尽。耗尽时报错会明说。

```bash
searchfuse config set antigravity-cli.model gemini-3.1-pro-high   # 更难的研究型问题
searchfuse config set antigravity-cli.bin /custom/path/to/agy
```

### tavily（搜索，免费额度）

每月 1,000 credits，不绑卡，基础搜索一次一个 credit。key 在 https://app.tavily.com 领。

```bash
searchfuse config set tavily.apiKey <key>
# 或环境变量：export TAVILY_API_KEY=<key>
```

给免注册额度和 agy 都耗尽时上的好保险：有 key 在，网页搜索会自动落到 Tavily。

### exa（搜索，每月免费额度）

每月循环 $10 额度，约 1,400 次搜索，不绑卡。key 在 https://exa.ai 领。

```bash
searchfuse config set exa.apiKey <key>
# 或环境变量：export EXA_API_KEY=<key>
```

Exa 返回排好序的链接和高亮片段，但不写综述，所以它的 summary 是机械拼的，证据在 `items` 里。它在搜索顺序中排在 Tavily 之后。

### firecrawl（搜索 + 抓取，默认免注册）

默认引擎，也是裸安装能直接干活的原因：Firecrawl 的免注册通道[每月送 1,000 免费 credits，无需注册](https://www.firecrawl.dev/blog/firecrawl-keyless-launch)。免注册请求不发送 Authorization header，按 IP 计量，受每日请求数和 credits 两项上限约束（[限流文档](https://docs.firecrawl.dev/rate-limits#keyless-no-api-key)没有公开每日上限的具体数字）。在 https://firecrawl.dev 领一个免费 key，可以再得独享的每月 1,000 credits 和更高限额：

```bash
searchfuse config set firecrawl.apiKey <key>
# 或环境变量：export FIRECRAWL_API_KEY=<key>
searchfuse config set firecrawl.keylessFetch false   # 让自动抓取不走云端
```

两个角色开箱都免 key 运行。抓取正是 Firecrawl 领跑的原因：它在云端跑真实浏览器，JavaScript 渲染的页面能带着本地引擎看不到的内容回来。这也意味着公网 URL 会被交给第三方，每次云端抓取的结果 warning 都会标明这条边界。想让自动抓取只走本地，设 `firecrawl.keylessFetch false`：搜索照常免 key，抓取则跳过 Firecrawl，除非配置了 key 或用 `-e firecrawl` 显式选它。URL 中直写的私有和保留地址目标始终跳过 Firecrawl，即使开着 `--allow-private-network` 也不例外。主机名的 DNS 结果采用更窄的云端披露规则。Clash、Surge 和 mihomo 使用的标准 fake-ip 池 `198.18.0.0/15` 会被视为占位值，只有所有解析地址都是真私网或保留地址时才会拦下。只要有一个公网地址就会放行。这个例外只作用于 DNS 结果。本地 SSRF 守卫仍把 `198.18.0.0/15` 判为私网，这个开关也只让本地引擎访问它。

每次 Firecrawl 抓取花一个 credit 并强制重新爬。searchfuse 发送 `maxAge: 0`，关掉 Firecrawl 默认的多天缓存，所以抓取永远不会拿到过期内容。这个取舍是故意的：一次抓取一个 credit，换来内容是新的，这正是工具的意义。想省 credits 不要新鲜度的话，Firecrawl 不是该选的引擎。

### keenable（搜索，默认免注册）

不要 key 也不用注册，在搜索顺序里排第二，紧跟 Firecrawl。免注册请求走 Keenable 的公共端点，每个 IP 每小时 1,000 次（同一 IP 上所有人共用），每秒最多 10 次。在 https://app.keenable.ai 领一个免费 key，请求就改走带 key 的端点：没有每小时上限，每个组织每月 100,000 次。

```bash
searchfuse config set keenable.apiKey <key>
# 或环境变量：export KEENABLE_API_KEY=<key>
```

Keenable 只搜索，所以 `-u` 配 `-e keenable` 会报错。它和 Exa 一样返回排好序的链接和片段（Keenable 有发布日期时也带上），但不写综述，所以 summary 是机械拼的，会有一条 warning 说明这一点，证据在 `items` 里。

### youcom（搜索，只有免注册）

不要 key 也不用注册，在搜索顺序里排第三，在 Firecrawl 和 Keenable 之后。请求走 `https://api.you.com/v1/agents/search`，每个 IP 每天 100 次（同一 IP 上所有人共用）。它没有 `apiKey`、`baseURL` 或模型设置，也没有带 key 的升级方式。`--max-results` 最多 50。想让自动路由跳过它，设 `engines.youcom.enabled: false`，`-e youcom` 仍可单次强制使用。

You.com 只搜索，所以 `-u` 配 `-e youcom` 会报错。它和 Keenable 一样返回排好序的链接和片段（You.com 有 `page_age` 时作为发布日期带上），但不写综述，所以 summary 是机械拼的，会有一条 warning 说明这一点，证据在 `items` 里。

### 第三方兼容端点（tavily、exa、firecrawl、keenable）

四个 HTTP 引擎可以指向任何与官方 API 同协议的端点：转售网关、区域代理、自建部署。设置 `baseURL` 后，引擎在它上面拼各自的文档路径（tavily 和 exa 是 `/search`，firecrawl 是 `/v2/search` 和 `/v2/scrape`，keenable 带 key 时是 `/v1/search`，免注册时是 `/v1/search/public`），所以 base 为 `https://gw.example.com/tavily` 时会请求 `https://gw.example.com/tavily/search`。

官方基地址内置在 provider 代码里，分别是 `https://api.tavily.com`、`https://api.exa.ai`、`https://api.firecrawl.dev`、`https://api.keenable.ai`。它们不会被复制进 `config.json`。`baseURL` 缺失或被清空都表示使用内置官方地址，这样后续版本修正默认值时不会被旧配置文件压住。dsh 设置卡片也遵守同一规则。

```bash
searchfuse config set tavily.baseURL https://gw.example.com/tavily
searchfuse config set tavily.baseURL ""        # 回到官方端点
# 或按次生效：export TAVILY_BASE_URL=... / EXA_BASE_URL=... / FIRECRAWL_BASE_URL=... / KEENABLE_BASE_URL=...
```

API key 会发给 base 指定的主机。这正是功能的意义，也正是信任决定：只指向你愿意把这个 key 交出去的主机。

### grok-cli（X，随 SuperGrok 或 X Premium 订阅）

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok    # 用户用 SuperGrok 或 X Premium 登录
```

不需要再开任何东西。`grok` 装好并登录后，X 味的查询自动去 X。没装的话，X 问题由公开网页作答，结果的 `warnings` 里会写明。

### local（抓取，零安装）

内置的直连抓取器（别名 `http` 和 `direct` 仍然可用）。无需设置。它带 SSRF 防护（私有地址段、云元数据、每一跳重定向检查、大小上限），并把连接钉在校验过的 IP 上，DNS 重绑定钻不过去。它不跑 JavaScript，也不是完整的浏览器沙箱：抓不可信的 URL 时，仍应在沙箱工作目录里跑。

两种代理形态：

1. TUN + fake-ip（Clash、Clash Verge Rev、mihomo、Surge）。DNS 返回的 `198.18.0.0/15` 地址会被视为 fake-ip 占位值，无需开启任何开关。连接仍固定到检查过的 fake-ip，Host 请求头和 TLS SNI 保留原域名。在 URL 中直接写 `http://198.18.0.5/`，`allowPrivateNetwork` 关闭时仍会被拦截。
2. 系统 HTTP 代理（`http_proxy` / `https_proxy` 环境变量，DNS 返回真实 IP）。需要设置这些环境变量。本地引擎会把请求转给代理。主机名由代理解析，所以 socket 不会钉在检查过的 IP 上。

如果分流 VPN 把公网主机名映射进其他保留地址段，或 Watt Toolkit / Steam++ 等 hosts 文件加速器将其指向回环地址，仍需用仅对本地抓取生效的开关放行：

```bash
searchfuse -u <url> --allow-private-network
searchfuse config set allowPrivateNetwork true   # 永久生效（顶层，全局）
```

## 额度冷却故障转移

某个 API key 因额度类错误失败时，searchfuse 把这个 key 记在 `~/.searchfuse/state.json`（与 `config.json` 分开）。下一次运行会先试同一引擎里的健康 key。只有所有已配置 key 都在冷却时，整个引擎才会移到后备链末尾。没有 API key 的引擎仍按引擎粒度冷却。这是软化的熔断器，不是负载均衡：健康 key 和健康引擎拿全部工作，冷却项仍保留为最后尝试。

- 冷却中的 key 不会被移除。某个 key 成功后只清除它自己的冷却。旧格式的引擎级状态仍可读取，并在任一 key 成功前作用于该引擎的所有 key。
- 引擎报错里的精确重置时间（agy 的 `Resets in 94h19m9s`）会被采用。没写时间的额度错误冷却 45 分钟。按秒的速率限制是瞬时的，从不记录。
- 显式 `-e`/`--engine` 仍是硬指定，不会跨引擎后备。同一引擎有多个 key 时，健康 key 仍排在冷却 key 前面。
- 结果的 `warnings` 会指出哪个 key 进入冷却。只有所有已配置 key 都在冷却并导致引擎后移时，路由 warning 才按引擎报告。

开关默认开：

```bash
searchfuse config set cooldown off   # 关闭：不读不写状态，路由与从前完全一致
searchfuse config set cooldown on    # 重新打开
searchfuse state clear               # 立即忘掉所有冷却
```

`searchfuse doctor` 会显示开关状态和当前在冷却的每个引擎或 key，以及剩余时间。

## 融合搜索

默认情况下 `web_search` 不再逐个尝试引擎。它会同时询问每个合格引擎，并合并它们的排序列表，于是答案反映多个索引，而不是谁先应答就用谁。

```
查询
  └─ 每个合格引擎，在同一个墙钟预算下并发
       └─ 倒数排名融合：得分 = Σ 1 / (60 + 名次)
            └─ 按规范化 URL 合并重复页面
```

**为什么用融合而不是故障转移。** 串行回退要先把最慢的失败等完，才去试下一个引擎；即便还有四个可用引擎能应答，它也只从单个索引取答案。融合只多花一轮并发请求，却返回共识：被两个引擎分别排在第一和第三的页面，得分高于只有一个引擎喜欢的页面。

**是倒数排名融合，不是数票。** 每个列表对它排名的每个页面贡献 `1/(60 + 名次)`，页面按得分之和排序。常数 60 用来压低相邻名次之间的差距；它是这个方法在文献里定下来的取值，不作为设置暴露。同分按规范化 URL 排序，于是同一个查询跑两遍会得到同样的顺序，而不取决于谁先应答。

**什么算同一个页面。** 合并之前每个 URL 都会规范化：去掉片段标识、去掉追踪参数（`utm_*`、`fbclid`、`gclid`、`mc_cid`、`mc_eid`、`ref`、`source`、`spm`）、剩余参数排序、host 小写、去掉默认端口、非根路径去掉末尾斜杠。`www.` 前缀与路径大小写**故意保留**：它们确实经常指向不同页面，合并它们会悄悄丢掉一个真实的第二来源。完全没有 URL 的条目则绝不互相合并，因为"没有链接"意味着地址未知，而不是两个结果指向同一页。

**结果形状。** 融合后的条目带 `score` 与 `foundIn`。`foundIn` 点名返回过这个页面的引擎，读者据此能分辨"多源共识"与"单一引擎的看法"。被合并条目的代表正文取各副本中最长的摘要，这样被截断的副本无法遮蔽完整的那份。

**部分失败不等于失败。** 一个引擎报错只损失它自己那份贡献。答案的其余部分照常成立，失败原因进 `uncertainty`。只有当什么都没回来时才抛错，且消息里点名每个引擎及其失败原因。

**被排除在外的引擎。** 因 `enabled: false`、`expose.aggregate: false`、本机不可用、或额度冷却而被排除的引擎，就是不参与。冷却不会瞒着自己：它会往 `uncertainty` 里加一行 `tavily: 处于冷却期，本次未参与（配额恢复后自动回归）`，措辞是"未参与"而不是"失败"，因为这两件事对读者含义不同。

**没东西可融合时。** 如果没有引擎合格，`web_search` 落回串行链，而不是用空结果作答。用 `--engine` 把运行钉在某一个引擎上时同理——一个被钉住的名字不是融合。

**缓存。** 一份融合答案在 `aggregate.cacheTtlMs`（默认五分钟）内可复用，键由查询、结果上限、以及产出它的引擎集合组成——是集合而不是顺序，因为顺序属于路由而非问题本身。重放会在摘要里说明。模型收窄问题时重复提问很常见，而免注册额度是按 IP 计量的，所以这能把第二次提问变成一次磁盘读取。`aggregate.cacheTtlMs: 0` 是强制重新跑一遍的官方办法。

**关掉它。** `searchfuse config set aggregate.mode chain` 精确恢复旧的串行行为。

## 能力矩阵

每个引擎回答两个互相独立的问题，配置可以自由组合：

| | `expose.aggregate: true` | `expose.aggregate: false` |
| :-- | :-- | :-- |
| **`expose.tool: true`** | 两者兼得：既贡献融合答案，也可按名调用 | 只做独立工具：被 `web_search` 跳过，可按名调用 |
| **`expose.tool: false`** | 只做融合：默认形态 | 关闭：既不融合也不做工具 |

```bash
searchfuse config set engines.tavily.expose.aggregate false
searchfuse config set engines.tavily.expose.tool true
searchfuse config set engines.tavily.toolName tavily_web
```

独立工具钉在它自己的引擎上、没有回退，供只想用那一个索引、不要融合答案的调用方使用。两个开关同时打开是最好用的形态：引擎既贡献 `web_search`，模型也能单独点名要它。

**需要你打开才生效。** 有两个引擎默认关闭，两者都仍然出现在设置卡片上，一键即可打开：

- `antigravity-cli` 靠模型合成答案，可能要一分钟以上，超过任何有用的融合预算。打开它：`searchfuse config set engines.antigravity-cli.enabled true`。
- `arxiv` 按任意词命中检索，语义太宽：查询 `electron main process` 会返回铜氧化物里的激子-极化激元论文，`react hooks tutorial` 会返回关于 cure model 的论文（命中 `tutorial`）与关于 hook length 的论文（命中 `hook`）。融合按名次排序而不看语义，于是一条无关的 arXiv 头名可能压过两个其他引擎都认可的页面。确实要做文献检索时再打开它：`searchfuse config set engines.arxiv.enabled true`。

两者都仍然会被 `searchfuse doctor` 报告，所以"装了吗"和"开着吗"始终是两个分开的答案。

## 每引擎代理

可以让一个引擎离开本机代理、其余照旧，也可以让它走一个别人都不用的代理：

```bash
searchfuse config set engines.searxng.proxy direct        # 仅此引擎：不走代理
searchfuse config set engines.tavily.proxy http://127.0.0.1:7890
searchfuse config set engines.tavily.proxy                # 回到本机设置
```

三种状态，而前两种之间的区分正是这个功能的要点：

| 取值 | 含义 |
| :-- | :-- |
| 未设或空 | 像以前一样跟随本机的 `http_proxy` / `https_proxy` / `no_proxy` |
| `direct` 或 `none` | 这个引擎绕过本机本来会用的一切代理 |
| 完整的 `http(s)://` URL | 这个引擎、且只有它，走那个代理 |

任何别的值都会被拒绝而不是忽略。笔误时回落到环境变量，会把手误出来的东西悄悄送进你正想避开的那个代理，而这正是这个设置存在的意义。

这是给一个引擎换一条路由的唯一办法，因为所有引擎共用一个进程：让免注册引擎走本地中继、让区域 API 走区域出口，或者让自建的 SearXNG 直连。

## MCP 服务端

插件自己就是 MCP 客户端。写在 `mcp` 下的服务端会变成普通工具，所以不需要另装 MCP 插件，也没有第二份配置文件。

```json
{
  "mcp": {
    "grep": { "transport": "streamable-http", "url": "https://mcp.grep.app" },
    "context7": { "transport": "streamable-http", "url": "https://mcp.context7.com/mcp" }
  }
}
```

每个服务端的工具以 `mcp__<server>__<tool>` 出现，与宿主自己的 MCP 客户端使用同一套命名，于是同一个工具无论由哪一侧注册看起来都一样。名字会折叠到工具接受的字符集，超过 64 字符时用稳定的哈希缩短。

**范围。** 只做 Streamable HTTP：只做工具，不做 resources 与 prompts，不支持 stdio 传输，不支持 OAuth。这覆盖了人们实际会桥接的那些匿名服务端。

**连不上的服务端绝不妨碍插件。** 搜索照常工作；一个死掉的服务端只损失它自己的工具、一行日志，以及 30 秒后的一次自动重试。

**会话在工具注册期间保持打开**，因为关掉它会让每次调用都付出一次重新握手的代价。插件卸载时它们会被关闭。

**重载。** 插件盯着配置文件，当服务端集合、它们的 URL、允许的工具清单、或工具名覆盖发生变化时重新注册。改别的东西（例如某个引擎的 key）不会让它们重新握手。

**诊断。** `searchfuse doctor` 会列出每个已配置的服务端、它的 URL、是否启用、以及键名是否合法——不合法的键会成为工具名的一部分。那一节只报告配置事实；真实连接结果出现在插件日志里，因为一次 doctor 运行是另一个进程，看不到宿主那份 session。

## 故障排查

- `firecrawl rejected the keyless request`：免注册访问暂不可用或达到限额。配置免费 Firecrawl key，等待每日额度恢复，或改用其他引擎。搜索没有 `local` 后备（`local` 不能搜索）。
- agy 的额度报错：每周免费额度用完了。加一个带 key 的搜索引擎，或等报错里写的重置时间。冷却开着时，agy 会被自动挪到最后直到重置。
- `keenable's keyless pool for this IP is used up for the hour`：本 IP 共用的免注册额度（每小时 1,000 次）用完了。下一个搜索引擎会接手。配一个免费 Keenable key 可得独享的每月 100,000 次。
- `youcom's keyless allowance for this IP is used up for the day (100 searches)`：本 IP 共用的免注册额度（每天 100 次）用完了。下一个搜索引擎会接手，You.com 不会进入冷却。它没有可加的 key，所以等到第二天或换其他引擎。其他失败的信息形如 `youcom returned <status> <statusText>. <body>`。
- `exa is out of credits` / `firecrawl is out of credits` / `keenable is out of credits`：当前额度用完了。其他搜索引擎会自动接手，冷却把耗尽的挪到最后直到恢复。
- `Blocked private network target`：SSRF 防护。用户在 VPN 后面的话，用 `--allow-private-network` 重试。
- 配置里引擎名写错：searchfuse 在 `warnings` 里说明，并照常用一个能干活的引擎。用户想要回那个引擎时把名字改对。
- 超时：先用 `--timeout 300000` 重试一次再上报失败。
