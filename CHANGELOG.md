# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

版本号从 0.1.0 重新起算。此前那轮 2.x–5.x 的开发记录仍在 git 历史里，但不再
作为发布线的一部分：它是同一个产品的多轮重写，不是 0.1.0 之前的版本。本文件
从这一版起重新记账。

## [Unreleased]

暂无。

## [0.1.1] - 2026-11-27

这一版只做一件事：**服务定位不再依赖一个会消失的文件**。

### Fixed

- **`runtime.json` 消失后三端全部失联（僵尸态）。** 该文件曾是服务身份的唯一
  凭证，而它在 `close()` 里被删除；进程被信号杀掉或崩溃时 `close` 跑不到，于是
  出现「服务还在听、文件已经没了」的状态。实测 PID 27056 监听 64683（**旧机制
  下的观测值**：那时端口由内核随机分配）而 `runtime.json` 不存在，三端读不到
  端口，全部退回 spawn 慢路径。
- **并发 `serve --ensure` 的进程雪崩。** `serve.port` 默认 0（内核随机挑端口），
  并发的多个实例各绑各的端口、全部成功、全部常驻，谁最后写 `runtime.json` 谁赢，
  其余成为占坑的孤儿。
- **先退出的实例会删掉后退出的那个的文件。** `close()` 原先无条件 `rmSync`，
  服务 A 关闭时把服务 B 写下的 `runtime.json` 一并删掉，B 瞬间变瞎。
- **5xx 错误正文被吞。** dsh 的 `tryServe` 早先「先探 `/healthz` 再返回」，
  服务活着但健康检查恰好不通时被判成「服务不存在」，于是回退 spawn kernel，
  服务端 5xx 正文里逐引擎的尝试轨迹就此消失，用户看到「不可达」而非真实原因。

### Added

- **目录指纹与确定性候选端口。** 指纹是 `sha256(realpath(~/.searchfuse).toLowerCase())`
  的前 8 位，归一化消除尾斜杠、`.` 段与大小写差异。候选端口从
  `42000 + (指纹 % 2000)` 起连续 8 个，同一份状态目录必然得到同一组。
  服务按候选顺序找第一个能绑的，被占则顺延，全部被占才报错。
- **`GET /identity` 端点。** 返回 `{port, pid, fingerprint, version}`，免鉴权、
  不泄露 token。客户端按候选端口逐个探测，**必须比对指纹**才认——只看 `/healthz`
  200 会把恰好占着那个端口的别的程序认成自己的服务，然后把 token 发给它。
- **两级服务定位。** `runtime.json` 降级为缓存：文件在且形状合法就直接用；
  文件不在才走候选探测。三端（CLI / dsh / Claude Code）同一套判定。
- **`hosts sync` 把身份写进 Claude settings。** mod 的沙箱里既没有 `process`
  也没有 `crypto`，算不了指纹，只能拿 CLI 预先算好的 `fingerprint` 与 `ports`。

### Changed

- **`/healthz` 的 body 保持纯文本 `OK`。** 四个现存消费者都只看状态码，
  把 body 换成 JSON 是无谓的破坏性变更；身份校验走独立的 `/identity`。
- **`typecheck` 接上 `omp/tsconfig.json` 与 `claude/tsconfig.json`。**
  此前这两份从来不在 CI 里跑，「四道类型门禁」实际只有两道在跑。

### Tests

- 新增 `src/serveIdentity.test.ts`（6 条）：确定性、归一化、候选范围与连续性。
- 新增 `src/serveIdentity.postcondition.test.ts`（8 条）：用真实 HTTP 服务
  钉住核心承诺——文件删掉后靠指纹找回服务、`ensureServeRunning` 不另起实例、
  陌生服务占着候选端口不会被误认、`/identity` 与目录推导一致、候选被占时顺延。
- 新增 `src/serveIdentity.parity.test.ts`（4 条）：锁住三份拷贝一致。任何一份
  漂移都会造成「服务绑一个端口、客户端去探另一个」，症状与「服务没起来」
  一模一样，是最难查的一类故障。
- 反向验证：破坏指纹校验 → 「陌生服务」那条变红；去掉候选探测层 →
  「不另起实例」那条变红。两条都亲眼看到变红再恢复。

三项实测的端到端结果：

1. **服务绑在候选段内。** 本机指纹 `21fe1ece` → 候选 `42158..42165`，服务实际绑
   42158，`runtime.json` 与 `/identity` 报出的指纹与推导值一致。
2. **文件消失后三端都能找回。** 删掉 `runtime.json` 后：CLI / serveEnsure 在
   42158 认出指纹；dsh 的 `locateServeRuntime` 走候选探测，真实搜到 28 条结果
   （内容 809 字符）；Claude Code 从 settings 里的 `ports` 逐个探测。
3. **并发不雪崩。** 6 个进程同时跑 `serve --ensure`：1 个起服务、5 个报
   「Already running」退出，候选段内只有 1 个 LISTENING。
4. **删掉 runtime.json 后再 ensure 不起第二个。** 这是审查员实证击穿的那条：
   修复前 A 活 42800 → 删文件 → B 起在 42801 → 两个都在听。修复后报
   「Already running on 42158」，监听数始终为 1。

### 审查后补齐（第二轮）

两轮独立审查（代码审查 + 测试守护力）之后补的：

- **`serve --ensure` 接上候选探测**（阻断级）。它是唯一真正起服务的入口，
  早先只信 `runtime.json`，文件一消失就在下一个候选上起第二个实例。判据
  抽成 `findRunningServe`，CLI 与插件侧共用同一个函数。
- **指纹改用 `realpathSync`**。junction 与它指向的目标现在算出同一个指纹。
  Windows 的 8.3 短名（`C:\Users\ADMINI~1`）仍不会被展开——实测确认，
  `os.homedir()` 正常返回长名时碰不到，文档已如实写明这个限制。
- **`syncClaudeSettings` 的早退判据**从「只比 enabled」改成「所有要写的字段
  都比」。升级用户的旧 settings 没有 fingerprint/ports，只看 enabled 会早退，
  新字段永远写不进去。
- **omp 与 claude 的 `runtime.json` 形状检查**补齐 `Number.isInteger` 校验，
  与 `serveEnsure` / `main.ts` 逐条一致。
- **`__APP_VERSION__` 只守卫一次**、`/identity` 与 runtime.json 写入共用。
  早先裸跑时服务能起、`/identity` 能答，但 runtime.json 永远写不出。
- **`parity` 测试改成抽取 dsh 真身函数体求值**。先前从源码抓数字再自己重建，
  常量对得上但归一化/取模/截断任一漂移时全量测试零红——实测把 dsh 的
  `.toLowerCase()` 删掉，838 条一条不红。现在三条反向验证都能变红
  （去掉 toLowerCase → 4 红、取模 2000→2001 → 2 红、截断 8→6 → 3 红）。
- **候选端口遇 `EACCES` 也换下一个**（不只是 `EADDRINUSE`）；`listening`
  改 `once`，避免候选重试时重复写 runtime.json。
- **候选模式下的实例收敛**：启动成功后检查前序候选，有同指纹服务就让位退出。
- **锁等待超时的错误文案**区分「持锁者还在跑」与「持锁者已死」两种真相。
- 删掉 `candidatePorts` 里永不触发的 `<= 65535` 守卫（它让函数可能返回少于
  8 个元素，与契约矛盾）；`serve.ts` 两处「固定端口」过时注释改成候选语义。

<!-- 0.1.0 的完整记录见下 -->


<!-- 0.1.0 的完整记录见下 -->

## [0.1.0] - 2026-11-26

首个正式版本。searchfuse 是一个给模型用的联网搜索插件：把搜索查询变成带来源
的结构化证据，并把这套能力同时以 CLI、技能和 dsh 插件三种形态交付。

### Added

- **融合搜索。** `web_search` 默认并发询问每个可达引擎，用倒数排名融合
  （`score = Σ 1/(60 + 名次)`）合并它们的排序列表，而不是逐个回退。一个被两个
  引擎分别排在第一和第三的页面，得分高于只有一个引擎喜欢的页面。可用
  `aggregate.mode chain` 退回旧的串行行为。
- **结果去重与佐证。** 合并前按规范化 URL 归一：去掉片段标识与追踪参数
  （`utm_*`、`fbclid`、`gclid`、`mc_cid`、`mc_eid`、`ref`、`source`、`spm`），
  剩余参数排序，host 小写，去掉默认端口与非根路径的尾斜杠。`www.` 前缀与路径
  大小写刻意保留，因为合并它们会悄悄丢掉一个真实的第二来源。融合后的条目带
  `score` 与 `foundIn`，读者据此能分辨多源共识与单一引擎的看法。
- **十个搜索与抓取引擎。** 搜索链固定为 Firecrawl、Keenable、AnySearch、
  You.com、SearXNG、Antigravity CLI、Tavily、Exa；抓取链是 Firecrawl、
  Antigravity CLI、`local`；Grok 覆盖 X 语料。前五台免注册或免 key：Firecrawl、
  Keenable、AnySearch、You.com 各有自己的免注册额度，SearXNG 默认用随包实例
  （它自己的七十多个上游引擎经一个适配器进来）。Tavily、Exa 各带免费月度额度，
  Antigravity CLI 靠浏览器登录并合成答案（默认关闭，因为它慢到超出融合预算）。
  AnySearch 可配 `ANYSEARCH_API_KEY` 提升额度；带 key 的请求被 401/403 拒绝时
  自动降级匿名档重试一次，并在 `warnings` 里注明。它的结果带相关性过滤：与查询
  无共享词汇的整批判空，让融合有机会换下一个引擎。
- **能力矩阵。** 每个引擎用两个正交开关自由组合：`expose.aggregate` 决定它是否
  进入融合答案，`expose.tool` 决定它是否另成一个可按名调用的独立工具，两者可
  同时开启。`toolName` 覆盖独立工具的名字。
- **每引擎独立代理。** `engines.<name>.proxy` 三态：留空跟随本机代理环境变量，
  `direct`/`none` 表示仅此引擎绕过系统代理，完整 URL 表示仅此引擎走它。既不是
  关键字也不是 http(s) URL 的值会被拒绝而不是忽略——笔误时回落到环境变量，会把
  流量送进用户正想避开的那个代理。
- **内建 MCP 客户端。** 写在 `mcp` 下的 Streamable HTTP 服务端变成普通工具，
  命名与宿主自己的 MCP 客户端一致（`mcp__<server>__<tool>`）。握手并发的，
  一个服务端连不上只损失它自己的工具，并在 30 秒后自动重试一次。握手与工具调用
  使用各自独立的超时上限。
- **配额冷却。** 额度耗尽的引擎自动退到链尾并记下恢复时间，月度额度（Tavily 的
  432/433）按二十四小时算，其余按四十五分钟算。冷却中的引擎不参与融合，并在
  `uncertainty` 里写明"未参与"而非"失败"。
- **`searchfuse doctor`。** 不花额度、不发网络请求地诊断本机配置：Node 版本、
  引擎选择与其来源、配置文件权限、每个角色的候选引擎及其就绪原因、融合与 MCP
  两节的配置事实，缺什么附一条可直接复制的修复命令。
- **dsh 设置卡片。** 网页端没有终端，所以卡片提供首选引擎、密钥与端点、引擎
  开关、曝光矩阵与每引擎代理。密钥永远不下发到浏览器，只报告"有没有存过"。
- **单引擎多密钥轮换。** 一个引擎可配逗号分隔的多个 key，鉴权、限流或配额失败
  时按顺序轮换，再把工作交给下一个引擎。

### Changed

- **Antigravity CLI 默认不激活。** 它靠模型合成并引用答案，动辄一分钟以上，
  超过任何有用的融合预算，留在链里也只能被跳过。它仍出现在设置卡片上，一键即可
  打开，`doctor` 也照常报告它是否可用。想要它就写
  `engines.antigravity-cli.enabled: true`。
- **代理遵循 `no_proxy`。** 引擎 API 调用与单页抓取走同一套代理规则，不再出现
  "抓网页能通、搜索全失败"的分裂状态。失败的调用会点名原因（`ECONNREFUSED`、
  `EAI_AGAIN`），而不是一句光秃秃的 `fetch failed`。
- **权限收紧。** 配置文件以 `0600` 写入，目录以 `0700` 创建，采用同目录临时
  文件加原子重命名，避免写到一半的 JSON 变成下一次启动的故障源。

### Removed

- **Hacker News 与 Stack Overflow 适配器。** 它们返回的内容对通用检索的价值低于
  维护成本，把名次让给语义更匹配的来源。
- **Playwright 抓取路径。** 页面抓取只保留 Firecrawl 云端、Antigravity CLI 与
  内置直连三种，少一个需要额外安装的运行时依赖。

### Fixed

- **融合不再把无链接条目合并成一条。** 五个 HTTP 引擎都用 `url: r.url ?? ''`
  构造条目，上游漏一个链接就会送来空串。空串经规范化后仍是空串，于是所有无链接
  条目共用同一个键：一批互不相干的结果被合并成一条、`foundIn` 声称多个引擎都投了
  它、虚高的分数还把它顶到第一位。现在空 URL 使用由引擎名与列表内序号组成的合成
  键，各自独立保留。
- **超时不再被报成"被取消"。** 原先只用一份信号判定归因，而调用方手里没有取消
  信号，只能把自己的超时信号传进来，于是每次预算耗尽都写成"the run was
  cancelled"，用户会以为是自己点了停止。现在以"预算先到即超时、外部先到即取消"
  两份精确信息区分。
- **关掉的引擎不会以工具身份复活。** `enabled: false` 是彻底的总开关，不只是
  "不参与融合"。
- **切换配置不再吞掉 `aggregate` 与 `mcp` 段。** 配置读取是一次白名单式重建，
  新增的顶层段必须在其中被搬运过去，否则每次 `config set` 都会把它们抹掉，而且
  不会报错——只会让工具在下次加载时安静地消失。
- **`__proto__` 不会伪装成引擎设置。** 引擎映射使用 null 原型对象，因为手工编辑
  的 `engines["__proto__"] = {...}` 在普通对象字面量上会设置原型而不是定义属性，
  于是该条目在枚举与序列化里隐形，却仍能被点号访问看到。
- **Windows 上退出时不再崩溃。** 已经打印完结果的搜索会设置退出码并让 Node 自行
  收尾，而不是立刻结束进程——后者可能拆掉一个仍在关闭中的网络连接，让检查退出码
  的调用方丢掉一份好结果。

### Security

- **SSRF 防护与 DNS 重绑定闭合。** 安全检查解析一次主机名后，连接会钉在它验证过
  的那个 IP 上，Host 头与 TLS SNI 仍保留原主机名；每个重定向跳转都重新校验并重新
  钉住，堵住"检查后 DNS 答案变化"的时间窗。
- **私有与保留地址默认拦截。** `allowPrivateNetwork` 打开后才放行，且它从不授权
  Firecrawl 云端披露——URL 中直写的私有目标在任何配置下都不会发往云端。
- **工具可执行文件不经 shell 启动。** 子进程引擎一律 `spawn(bin, args)` 且不带
  shell，避免把参数拼进命令行。图形宿主下子进程窗口被隐藏，并有契约测试扫描发布
  源码，防止以后新加的 provider 悄悄把黑窗口闪回来。
- **密钥从不进入模型可读的输出。** `config show`、`doctor` 与卡片一律打码，只报告
  密钥来自环境变量还是配置文件。

### Compatibility

- **cordis 4.2 兼容**：`engines.dsh` 补上 `<0.3.0-0` 上界（DSH 0.2.3 系列
  随包带入 cordis 4.2.0-alpha.1 与 schemastery 3.20.0-alpha.1，实测引擎闸门
  与 bundle 组合均无回归）。
- **工具链在发版前全部升到最新**：TypeScript 5.9 → 7.0、Vite 6.4 → 8.3、
  Vitest 3.2 → 5.1、Biome 2.5 → 2.6、commander 13 → 15、undici 7.30 → 8.13、
  `@searxng-js/searxng` 0.1.2 → 0.1.3，CI 与 `packageManager` 一并钉在
  pnpm 12.23。两处必须跟着改：TypeScript 7 要求 `tsconfig.dsh.json` 显式写
  `rootDir`（否则退出码 2、`dsh/index.js` 不生成，包装不上）；undici 8 对
  `http://` 目标改用标准代理转发而非 CONNECT 隧道，测试里的假代理两条路都要接。

[Unreleased]: https://github.com/Wenaixi/searchfuse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Wenaixi/searchfuse/releases/tag/v0.1.0
