# SearchFuse CLI 手册

skill 通过启动器驱动这个 CLI。这一页讲的是直接运行它。

## 直接使用

装好 skill 后不需要敲命令：问任何需要查证的问题，或贴一个 URL，它就会自己触发，启动器负责选择怎么运行 searchfuse。下面的命令用于在有 Node 的机器上自己驱动 CLI：

```bash
searchfuse -q "current Node.js LTS version"     # 搜网页
searchfuse -u "https://nodejs.org/en/about"     # 读一个页面，加 -q 指定关注点
searchfuse -q "reactions on X" --source x       # 搜 X，关于 X 的查询会自动路由过去
```

输出永远是一个 `results` 数组，每个语料一条：

```json
{
  "mode": "search",
  "results": [{
    "source": "web",
    "engine": "firecrawl,keenable,anysearch,youcom,searxng",
    "summary": "Fused 12 result(s) from 5 engine(s) (firecrawl, keenable, anysearch, youcom, searxng). 3 result(s) were returned by more than one engine.",
    "items": [{
      "title": "...",
      "url": "https://...",
      "published_at": "2026-08-03",
      "score": 0.0328,
      "foundIn": ["firecrawl", "keenable"]
    }],
    "uncertainty": [],
    "warnings": [],
    "attempts": [],
    "durationSeconds": 5.5
  }]
}
```

**默认是融合模式，形状与链式有两处不同：**

| | 融合（默认） | 链式（`-e` 或 `aggregate.mode chain`） |
| :-- | :-- | :-- |
| `engine` | 逗号连接的多引擎列表 | 单个引擎名 |
| `attempts` | 空数组，失败与跳过写进 `uncertainty` | 每次请求一条记录 |
| 每条 `items` | 带 `score` 与 `foundIn` | 不带这两个字段 |

融合结果的 `summary` 是机械生成的，说明融合了多少条、来自几家引擎、其中几条被多家共同返回；链式的 `summary` 才是引擎自己写的综述。`uncertainty` 在融合模式下也承载「某个引擎失败或被跳过」，措辞区分「未参与」与「失败」。链式的完整信封见[输出契约](output-schema.md)。

## 参数

| 参数 | 含义 | 默认 |
| :-- | :-- | :-- |
| `-q, --query <text>` | 查询语句，与 `-u` 搭配时是提取关注点 | |
| `-u, --url <url>` | 抓取这个页面，而不是搜索 | |
| `-s, --source <list>` | 语料：`web`、`x` 或 `web,x` | 由查询判断，否则 `web` |
| `-e, --engine <name>` | 本次只用这个引擎。失败时直接报错，不换引擎 | 自动 |
| `-o, --output <path>` | 同时把 JSON 写入文件 | |
| `-m, --model <name>` | 引擎模型 | `gemini-3.8-flash-low` |
| `--prompt <text>` | 本次运行的附加约束，传给引擎 | |
| `--max-results <n>` | 搜索结果上限 | `8` |
| `--timeout <ms>` | 单个引擎最多用多久。引擎失败后换下一个，下一个重新计时 | `180000` |
| `--deadline <ms>` | 整次运行最多用多久，所有引擎合计，从 CLI 启动那一刻算起。每个引擎取 `--timeout` 和剩余时间中较小的那个，轮到时已超时的引擎直接跳过。到点不理会停止信号的引擎被强制结束前，退出最多再晚 2 秒 | 无 |
| `--workdir <path>` | 运行命令类引擎的工作目录 | 当前目录 |
| `--allow-private-network` | 允许本地抓取器访问保留地址段，给把公网主机映射进去的 VPN 用 | 关 |

配置是可选的。`~/.searchfuse/config.json` 可以指定首选引擎（`searchfuse config set engine tavily`，空表示自动），也可以把单个引擎排除在自动故障转移之外（`searchfuse config set tavily.enabled false`）。没有覆盖时每个引擎都参与。额度冷却故障转移默认开，`searchfuse config set cooldown off` 关掉，`searchfuse state clear` 重置冷却记录。完整的文件结构和每个字段，包括顶层的 `allowPrivateNetwork` 开关，见[配置文档](configure.md)。

`searchfuse doctor` 打印本机诊断：Node 版本、每项任务的引擎就绪状态与启用状态、每个配置值的来源、私有网络设置、当前在冷却的引擎。就绪与启用分开报告。它不花额度、不发网络请求，`--json` 让输出可被程序读取。路由行为不符合预期时先跑它。

## 平台支持

macOS 和 Linux 完整支持，CI 在 Linux 的 Node 22 / 24 / 26 与 Windows 的 Node 22 / 26 上跑全量测试。skill 附带两个启动器，macOS 和 Linux 用 `scripts/run.sh`，Windows 用 `scripts/run.ps1`，它们自动选择可用的运行方式，三个平台行为一致。

CI 矩阵同样包含 `windows-latest` 的 Node 22 和 26，跑同一套 typecheck、测试、构建关卡。各部分在 Windows 上的可用性取决于它依赖什么：

- **CLI 本体、路由与配置逻辑、HTTP 引擎**（`local` 抓取、Tavily、Exa、Firecrawl、Keenable、AnySearch、You.com、SearXNG）是纯 Node：只用 `fetch` 和文件系统，天然跨平台。
- **agy 和 grok 是外部 CLI。** searchfuse 不经 shell 按名字直接运行它们，所以 PATH 上的原生 Windows 可执行文件可用，npm 风格的 `.cmd` 垫片不可用。有没有 Windows 构建是每个工具自己的决定，不是 searchfuse 的。每个直接子进程都会带 `windowsHide: true` 启动，因此没有控制台的 GUI 宿主不会在每次调用时闪出黑框。
- **冷却状态文件**通过临时文件加原子重命名写入。Windows 上这个重命名能替换目标，但替换不了被其他进程占用的文件，所以极少数的同时写入竞争可能丢掉一次写。这个存储是读取时合并的尽力缓存，丢掉的内容后续运行会重新发现。
