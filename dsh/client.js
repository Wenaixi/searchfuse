// modsearch dsh 插件的浏览器半边：设置卡片。
//
// dsh 的 Web 用户没有终端，`modsearch config set` 在那里够不着，引擎密钥
// 也就没有输入的口子。dsh 不会按设置 schema 渲染通用表单，所以这张卡片
// 通过 slot 贡献出去，而不是声明成一份 schema：dsh 0.1.6-alpha.2 起是
// 插件页上的 `plugins.bundle.config`，之前是设置页里的
// `settings.plugin.item`。它读写插件自己的路由，那条路由掌管
// ~/.searchfuse/config.json：浏览器永远看不到 API 密钥，也永远不会拿空值
// 覆盖已保存的密钥。
//
// 按 lazy-CJS 包协议手写（window.__ModuleLoader__.load，工厂函数返回
// cordis-plugin 的导出），所以没有构建步骤，也不从 dsh 客户端包里 import：
// 与宿主半边同样的零依赖立场。
window.__ModuleLoader__.load({
  id: '@wenaixi/searchfuse',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 卡片提供的引擎，按文档介绍它们的顺序排列。宿主半边带着同一份列表；
    // 两边各自写明自己要展示的东西。
    var ENGINES = [
      'antigravity-cli',
      'tavily',
      'exa',
      'firecrawl',
      'keenable',
      'anysearch',
      'youcom',
      'searxng',
      'grok-cli',
      'local',
    ];

    // 既不需要密钥、也不需要注册就能搜索的引擎。
    var KEYLESS_ENGINES = ['firecrawl', 'keenable', 'anysearch', 'youcom', 'searxng'];

    // 故障转移链是一排搜索引擎，所以取页器不在其中。`local` 只读取交给它
    // 的一个 URL，本身不做任何搜索；在这一排里给它一个勾选框，只会招来一个
    // 不改变任何搜索的决定。
    var CHAIN_ENGINES = ENGINES.filter((name) => name !== 'local');

    // 插件页按 npm 包名把配置分派给对应的 bundle。
    var PACKAGE_NAME = '@wenaixi/searchfuse';

    // 用两套短标签，而不是一个 locale 包：这张卡片总共几十个字符串，
    // 为它配一个包，机械开销比被标注的东西本身还大。
    var TEXT = {
      en: {
        title: 'Search engine (ModSearch)',
        subtitle: 'Search engine provider configuration.',
        // 插件页上的小标题，那里已经写着插件名。
        section: 'Engine settings',
        automatic: 'Automatic (chain order decides)',
        // 免密钥这个默认说法放在列表里，也就是用户选引擎的地方。
        keylessSuffix: ' (keyless free tier)',
        pickToConfigure: 'Pick an engine above to configure its key and endpoint.',
        mcpSection: 'MCP servers',
        mcpHint:
          'Context7 and grep are registered by default. Set a proxy per server if one needs to reach the network differently from the rest.',
        mcpDefault: 'default',
        mcpUrl: 'Server URL',
        mcpProxy: 'Proxy',
        mcpProxyHint:
          'Empty keeps the machine proxy. "direct" or "none" bypasses it for this server alone.',
        mcpPickToConfigure: 'Pick an MCP server above to edit its URL or proxy.',
        mcpEnabled: 'Enabled',
        mcpDisabled: 'disabled',
        expandHint: 'click to edit',
        collapseHint: 'editing',
        searxngSection: 'SearXNG upstream engines',
        searxngTitle: 'SearXNG',
        searxngNetworkEmpty: 'No named networks yet. Add one, then reference it from an engine rule.',
        searxngNoProxySet: 'no proxy set',
        searxngModeLabel: 'How SearXNG runs',
        searxngModeOff: 'Off',
        searxngModeEmbedded: 'Bundled instance',
        searxngModeExternal: 'External instance',
        searxngModeHint:
          'Only one source can serve SearXNG at a time. Switching starts or stops the bundled instance on save (about 1-2 seconds).',
        searxngExternalURL: 'Service URL',
        searxngExternalProxy: 'Request proxy',
        searxngDefaultProxy: 'Default proxy',
        searxngDefaultProxyHint:
          'Applies to upstream engines that have no proxy of their own. One per line; several entries are used round-robin.',
        searxngFilterPlaceholder: 'Filter engines by name',
        searxngScopeModified: 'Changed',
        searxngScopeEnabled: 'Enabled',
        searxngScopeAll: 'All',
        searxngShowMore: 'Show {n} more',
        searxngFollowDefault: 'Follow default proxy',
        searxngUpstreamTitle: 'Upstream engines',
        searxngAdvanced: 'Named networks',
        searxngAdvancedHint: 'Groups of proxies that engine rules can reference by name.',
        searxngTorBadge: 'Tor',
        searxngNetworkBadge: 'network',
        readyLabel: 'ready',
        notReadyLabel: 'not ready',
        keySetLabel: 'key set',
        envBadge: 'env',
        autoToggleHint: 'Include this engine in automatic routing',
        // 状态总览与引擎分组（设置界面重构）。
        overviewEngines: '{n} engines ready',
        overviewNoEngines: 'no engine ready',
        overviewSearxngEmbedded: 'SearXNG bundled on',
        overviewSearxngExternal: 'SearXNG external set',
        overviewSearxngOff: 'SearXNG off',
        overviewMcp: '{n} MCP on',
        strategyTitle: 'Search strategy',
        strategyHint:
          'The preferred engine answers first; the rest of the chain is the fallback order.',
        groupKeyed: 'Needs an API key',
        groupKeyedHint: 'Paste a key once and it works everywhere.',
        groupKeyless: 'Works out of the box',
        groupKeylessHint: 'No key needed. A key only raises the quota.',
        groupCli: 'Needs a local CLI',
        groupCliHint: 'Install the command-line tool on this machine, then sign in.',
        advancedTitle: 'Advanced (endpoint / model / proxy / exposure)',
        advancedCustomized: '{n} customized',
        keyPlaceholderEnv: 'Using the environment variable (type to override)',
        keyPlaceholderSet: 'Key saved (leave blank to keep)',
        clearKey: 'Clear key',
        advancedSection: 'Advanced settings',
        advancedHint: 'Endpoint, model, exposure form, and tool name. Most setups leave these alone.',
        proxyDisclosureHint: 'Empty follows the machine proxy. "direct" or "none" bypasses it for this engine alone.',
        engine: 'Preferred engine',
        apiKey: 'API key',
        apiKeyHint:
          'Separate multiple keys with commas. ModSearch rotates to the next key after authentication, rate-limit, or quota failures.',
        baseUrl: 'Base URL',
        model: 'Model',
        stored: 'stored, leave empty to keep it',
        unset: 'not set',
        endpointFallback: 'Built-in official endpoint, leave blank to use it',
        modelFallback: 'engine default',
        save: 'Save',
        saving: 'saving...',
        saved: 'saved',
        loading: 'loading...',
        discard: 'Discard',
        cliNote: 'This engine runs a local command-line tool: no key, no endpoint.',
        localNote: 'The built-in fetcher reads pages directly: no key, no endpoint.',
        youcomNote:
          "Runs on You.com's keyless free tier (100 searches a day per IP): no key, no endpoint.",
        envNote:
          'This key comes from an environment variable, which overrides the config file. Clear the variable to let a saved key take effect.',
        autoTitle: 'Automatic engine chain',
        autoHint: 'Checked engines may join failover. Only engines ready here are listed.',
        autoUnknown: 'Engine status is unavailable right now, so every engine is listed.',
        autoEmpty: 'No engine is ready on this machine yet.',
        // 两条针对具体引擎的附注，各自由独立分支渲染，删掉任何一条都不必
        // 动卡片的其他部分。
        socialOnly: 'X search only',
        keylessTier: 'Runs on the keyless free tier by default. Add a key to raise the quota.',
        loadFailed: 'load failed',
        saveFailed: 'save failed',
        retry: 'Retry',
        exposeTitle: 'How this engine is exposed',
        exposeHint:
          'Choose one form per engine: join the fused web_search answer, stand alone as a tool the model can call by name, both, or off.',
        exposeStates: {
          aggregate: 'Fused into web_search only',
          tool: 'Standalone tool only',
          both: 'Fused and standalone',
          off: 'Off',
        },
        toolNameLabel: 'Tool name',
        toolNameHint:
          'The name the model calls. Two engines cannot share a name, and the built-in tool names are reserved.',
        proxyLabel: 'Proxy',
        proxyFallback: 'Leave blank to follow the system proxy',
        proxyHint:
          'Route only this engine through its own proxy. "direct" or "none" bypasses the system proxy for this engine alone.',
      },
      zh: {
        // 不叫「网页搜索」：dsh 自带一张「网页搜索（DeepSeek 搜索提供方）」卡片，
        // 同一份列表里两个开头一样的名字谁也认不出来。这个名字与同门插件的
        // 「视觉引擎（ModLens）」成对。
        title: '搜索引擎（ModSearch）',
        subtitle: '搜索引擎提供商配置。',
        section: '引擎设置',
        automatic: '自动（按故障转移顺序）',
        keylessSuffix: '（免注册免费）',
        pickToConfigure: '在上面选一个引擎，才能配置它的密钥和地址。',
        mcpSection: 'MCP 服务',
        mcpHint:
          'context7 与 grep 默认注册。某个服务需要走不同的网络路径时，可以单独给它配代理。',
        mcpDefault: '默认',
        mcpUrl: '服务地址',
        mcpProxy: '代理',
        mcpProxyHint: '留空跟随系统代理；填 "direct" 或 "none" 表示这个服务单独直连。',
        mcpPickToConfigure: '在上面选一个 MCP 服务，才能编辑它的地址或代理。',
        mcpEnabled: '启用',
        mcpDisabled: '已禁用',
        expandHint: '点击编辑',
        collapseHint: '编辑中',
        searxngSection: 'SearXNG 上游引擎',
        searxngTitle: 'SearXNG',
        searxngNetworkEmpty: '还没有命名网络。先添加一个，再让某个引擎规则引用它。',
        searxngNoProxySet: '未设代理',
        searxngModeLabel: 'SearXNG 运行方式',
        searxngModeOff: '关闭',
        searxngModeEmbedded: '内置实例',
        searxngModeExternal: '外部实例',
        searxngModeHint:
          '同一时间只有一种来源能服务 SearXNG。切换会在保存时启停内置实例，约需 1 到 2 秒。',
        searxngExternalURL: '服务地址',
        searxngExternalProxy: '请求代理',
        searxngDefaultProxy: '默认代理',
        searxngDefaultProxyHint:
          '作用于没有单独配置代理的上游引擎。一行一个，多个会按顺序轮询。',
        searxngFilterPlaceholder: '按名称过滤上游引擎',
        searxngScopeModified: '已修改',
        searxngScopeEnabled: '已启用',
        searxngScopeAll: '全部',
        searxngShowMore: '再显示 {n} 项',
        searxngFollowDefault: '跟随默认代理',
        searxngUpstreamTitle: '上游引擎',
        searxngAdvanced: '命名网络',
        searxngAdvancedHint: '实体代理组，引擎规则可以按名字引用它们。',
        searxngTorBadge: 'Tor',
        searxngNetworkBadge: '网络',
        readyLabel: '就绪',
        notReadyLabel: '未就绪',
        keySetLabel: '已存密钥',
        envBadge: '环境变量',
        autoToggleHint: '让这个引擎参与自动故障转移',
        // 状态总览与引擎分组（设置界面重构）。
        overviewEngines: '{n} 个引擎可用',
        overviewNoEngines: '没有可用的引擎',
        overviewSearxngEmbedded: 'SearXNG 内置已启用',
        overviewSearxngExternal: 'SearXNG 外部已配置',
        overviewSearxngOff: 'SearXNG 未启用',
        overviewMcp: '{n} 个 MCP 已启用',
        strategyTitle: '搜索策略',
        strategyHint: '首选引擎先答，其余按故障转移顺序接手。',
        groupKeyed: '需要 API 密钥',
        groupKeyedHint: '填一次密钥即可用。',
        groupKeyless: '开箱可用',
        groupKeylessHint: '不需要密钥；填密钥只是提高额度。',
        groupCli: '需安装本地 CLI',
        groupCliHint: '先在本机装好命令行工具并登录。',
        advancedTitle: '高级选项（端点 / 模型 / 代理 / 露出形态）',
        advancedCustomized: '已自定义 {n} 项',
        keyPlaceholderEnv: '正在使用环境变量（输入以覆盖）',
        keyPlaceholderSet: '已保存密钥（留空保持不变）',
        clearKey: '清除密钥',
        advancedSection: '高级设置',
        advancedHint: '接口地址、模型、露出形态与工具名。多数情况下不需要改动。',
        proxyDisclosureHint: '留空跟随系统代理；"direct" 或 "none" 表示只有这个引擎直连。',
        engine: '首选引擎',
        apiKey: 'API 密钥',
        apiKeyHint: '多个密钥用英文逗号分隔。鉴权、限流或配额失败时会自动轮换到下一个密钥。',
        baseUrl: '接口地址',
        model: '模型',
        stored: '已保存，留空即不改动',
        unset: '未设置',
        endpointFallback: '内置官方地址，留空即可使用',
        modelFallback: '使用该引擎默认值',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        loading: '加载中…',
        discard: '放弃修改',
        cliNote: '该引擎走本机命令行工具，无需密钥和接口地址。',
        localNote: '内置抓取器直连读取网页，无需密钥和接口地址。',
        youcomNote: '走 You.com 免注册免费额度（每个 IP 每天 100 次），无需密钥和接口地址。',
        envNote: '该密钥来自环境变量，环境变量优先于配置文件。清掉变量后保存的密钥才会生效。',
        autoTitle: '自动引擎链',
        autoHint: '勾选后可参与故障转移。这里只列出本机已就绪的引擎。',
        autoUnknown: '暂时读不到引擎状态，所以列出全部引擎。',
        autoEmpty: '本机暂无就绪的引擎。',
        socialOnly: '仅 X 搜索',
        keylessTier: '默认使用免注册的免费额度，填入密钥可提高配额。',
        loadFailed: '加载失败',
        saveFailed: '保存失败',
        retry: '重试',
        exposeTitle: '这个引擎怎么露出',
        exposeHint:
          '每个引擎选一种形态：只参与 web_search 融合、只作为独立工具供模型点名调用、两者兼得，或关闭。',
        exposeStates: {
          aggregate: '只融入 web_search',
          tool: '只作为独立工具',
          both: '既融合也独立',
          off: '关闭',
        },
        toolNameLabel: '工具名',
        toolNameHint: '模型调用时看到的名字。两个引擎不能同名，内置工具名已被占用。',
        proxyLabel: '代理',
        proxyFallback: '留空则跟随系统代理',
        proxyHint:
          '只让这个引擎走自己的代理。填 "direct" 或 "none" 表示仅此引擎绕过系统代理。',
      },
    };

    // 这张卡片说的语言。`active` 是 dsh 自己的界面语言，前提是 locale
    // 服务在场能报出来。优先问它，因为页面语言并不是答案：构建出来的
    // index.html 把 `<html lang="zh-CN">` 冻死了，从不重写，于是设为英文的
    // 用户仍会读到一张中文卡片。服务缺席时（老版本宿主、不带 locale 的
    // profile），才由页面语言、再退到浏览器语言来定。
    function labels(active) {
      var lang = (
        active ||
        document.documentElement.lang ||
        navigator.language ||
        'en'
      ).toLowerCase();
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en;
    }

    // 请求失败时页脚显示什么。服务器说了什么就原样带过来，不翻译
    // （'unknown engine: x'、某个路径错误）：那是诊断信息，把它映射成错误码
    // 换来的会是一张翻译表，接触面远大于这张卡片本身的价值。只有静默的
    // 情况——没有任何细节可显示——才给一行本地化文案。
    function noteFrom(error, fallback) {
      // message 为空的 Error 属于「没有细节」那一类，不该被字符串化：
      // 对它调 String(error) 只会得到 'Error'。
      var detail =
        error && typeof error.message === 'string' ? error.message : error ? String(error) : '';
      return detail || fallback;
    }

    /** 这个引擎是否根本就有密钥和接口地址可配。 */
    function keyed(summary, engine) {
      return engine !== '' && (summary.keyed || []).indexOf(engine) >= 0;
    }

    /** 这个引擎是否接受 base URL（需要密钥的引擎与 SearXNG）。 */
    function endpointable(summary, engine) {
      return engine !== '' && (summary.endpoints || []).indexOf(engine) >= 0;
    }

    /**
     * 某次运行是否读取这个引擎的 `model` 设置。 */
    function modelled(summary, engine) {
      return engine !== '' && (summary.models || []).indexOf(engine) >= 0;
    }

    /**
     * 一个引擎的露出形态，取自四个具名状态之一。
     *
     * `aggregate` 和 `tool` 彼此正交，若把它们显示成两个独立的勾选框，就会
     * 引导出「这是两个互不相关的开关」这种读法。它们其实是对形态的一次
     * 选择：一个引擎加入融合答案、变成模型可以点名调用的工具、两者兼得，
     * 或者关闭。把二者收拢成一次单选，这项选择才以它本来的样子呈现。
     */
    var EXPOSE_STATES = ['both', 'aggregate', 'tool', 'off'];

    function exposeState(summary, engine) {
      var settings = (summary.engines && summary.engines[engine]) || {};
      var expose = settings.expose || {};
      var aggregate = expose.aggregate !== false;
      var tool = expose.tool === true;
      if (settings.enabled === false) {
        return 'off';
      }
      if (aggregate && tool) {
        return 'both';
      }
      if (aggregate) {
        return 'aggregate';
      }
      if (tool) {
        return 'tool';
      }
      // 两个标记都没设：引擎仍然能直接应答，所以把它称作关闭，会是一句
      // 保存动作兜不住谎。
      return 'off';
    }

    /** 某个状态所代表的 `enabled`/`expose`。 */
    function stateToSetting(state) {
      if (state === 'off') {
        return { enabled: false, expose: { aggregate: false, tool: false } };
      }
      if (state === 'both') {
        return { enabled: true, expose: { aggregate: true, tool: true } };
      }
      if (state === 'tool') {
        return { enabled: true, expose: { aggregate: false, tool: true } };
      }
      return { enabled: true, expose: { aggregate: true, tool: false } };
    }

    /** 状态包含独立工具时显示的工具名。 */
    function toolNameFor(summary, engine) {
      var settings = (summary.engines && summary.engines[engine]) || {};
      return settings.toolName || engine + '_search';
    }

    /**
     * 从摘要推出当前 SearXNG 模式。
     *
     * 与后端 `engineSettings()` 的判据保持一致：**未写 embedded 等于开启**。
     * 三态互斥，判据按优先级：
     *   1. 配了 baseURL → 外部实例（后端也是这条优先）；
     *   2. searxng 段存在且 embedded === false → 显式关闭；
     *   3. 其余（段缺席，或 embedded 为 true）→ 内置实例。
     *
     * 曾经的实现把「段存在」当成内置，于是文件里显式写 false 时界面仍显示
     * 开着；又把「段缺席」判成关闭，与后端默认相反。两种错都指向同一件事：
     * 卡片必须在「用户看到什么」与「运行时真的做什么」之间保持一致。
     */
    function searxngModeOf(summary) {
      var base = (summary?.engines?.searxng?.baseURL || '').trim();
      if (base !== '') return 'external';
      var searxng = summary?.searxng;
      if (searxng !== undefined && searxng !== null && searxng.embedded === false) {
        return 'off';
      }
      return 'embedded';
    }

    // 引擎切换或新的摘要到达时的下一份草稿。那些字段属于新选中的引擎，
    // 所以切换引擎永远不会把一个引擎的接口地址拷贝到另一个引擎上。
    function nextDraft(summary, engine, keepEnabled) {
      // engine 为 '' 本身就是一种答案：未固定，由可用性决定。此时不存在
      // 某个引擎的密钥该放进这些字段，于是它们保持为空，卡片再说明怎么把
      // 它们找回来。
      var current = summary.engines?.[engine] || { baseURL: '', model: '' };
      return {
        engine: engine,
        apiKey: '',
        baseURL: current.baseURL || '',
        model: current.model || '',
        // 空表示「不改动文件里的值」，与 API 密钥字段空着时的含义一致。
        // 否则，预填的代理会让每一次哪怕只改了别处的保存都重写文件。
        proxy: '',
        toolName: current.toolName || '',
        exposeState: exposeState(summary, engine),
        enabled: Object.assign(
          {},
          keepEnabled ||
            Object.fromEntries(
              ENGINES.map((name) => [name, summary.engines?.[name]?.enabled !== false]),
            ),
        ),
        // 正在原地展开编辑的引擎。'' 表示没有展开任何一个。
        //
        // 它与 draft.engine 是**两件不同的事**：engine 是「首选引擎」，会
        // 写进配置文件；editTarget 只是「这张卡片此刻在看哪一个」。
        // 之前把两者合成一个下拉框，于是想改 exa 的密钥得先把它设成首选，
        // 顺序完全反了 —— 那是把编辑器和偏好强行绑在一起。
        //
        // nextDraft 的入参就是「要为哪个引擎准备草稿」，所以它天然
        // 就是 editTarget。savePayload 也只按 editTarget 提交字段。
        editTarget: engine,
        // MCP 的编辑区：`mcpTarget` 是当前展开的 server，其余是该 server
        // 的待提交值。空字段表示「不改动文件」，与代理字段的契约一致。
        mcpTarget: '',
        mcpUrl: '',
        mcpProxy: '',
        mcpEnabled: true,
        // SearXNG 的运行模式是三态互斥，不再是「内置开关 + 外部地址」两个
        // 各自独立的输入：同时开着内置又填了外部地址，是一个说不清谁优先
        // 的非法状态。这里把它收敛成一个选择。
        //   'off'     —— 不参与
        //   'embedded'—— 用随包实例
        //   'external'—— 用用户给的外部实例
        //
        // 它是 SearXNG 实例选择的**唯一真源**。早先还并存一个布尔字段
        // `searxngEmbedded`，两处各存一份状态，保存时按哪个算就成了运气。
        searxngMode: searxngModeOf(summary),
        // 外部实例的地址与代理（草稿值，空表示不改动文件）。
        searxngExternalURL: (summary?.engines?.searxng?.baseURL || ''),
        searxngExternalProxy: '',
        // 默认代理（outgoing.proxies.all://），作用于没有单独配置的上游引擎。
        searxngDefaultProxy: proxiesToText(summary?.searxng?.outgoing),
        // 上游引擎清单的过滤词与筛选档位，只描述这张卡片此刻怎么显示。
        searxngFilter: '',
        searxngScope: 'enabled',
        searxngShowAll: false,
        searxngEngineName: '',
        // 逐引擎的启用/禁用与代理草稿，按引擎名索引。
        searxngRules: Object.assign(
          {},
          ...Object.entries((summary?.searxng?.engines) || {}).map(([name, rule]) => ({
            [name]: {
              enabled: rule?.disabled !== true,
              proxy: proxiesToText(rule?.proxies),
            },
          })),
        ),
      };
    }

    /** 展开某个 MCP server 的编辑区，把它的当前值填进去。 */
    function selectMcp(summary, draft, name) {
      var next = Object.assign({}, draft, { mcpTarget: name });
      if (name === '') {
        next.mcpUrl = '';
        next.mcpProxy = '';
        next.mcpEnabled = true;
        return next;
      }
      var server = (summary.mcp || {})[name] || {};
      next.mcpUrl = server.url || '';
      // 与引擎字段同一份契约：空表示「不改动文件」，否则预填值会让每一次
      // 保存都重写一遍文件。所以这里也留空，让用户只在真的要改时填写。
      next.mcpProxy = '';
      next.mcpEnabled = server.enabled !== false;
      return next;
    }

    /**
     * 选择一个首选引擎，并让这项偏好发生在用户看得见的地方。
     *
     * 只有屏幕上带勾选框的引擎才会在这里被打开。去勾选一个隐藏的引擎，
     * 等于做了一次没人要求、也没人看得见的改动，随后的保存还会删掉一条
     * 用户从不知道存在的 `enabled: false`。没有行的引擎保持文件里写好的
     * 值：偏好照旧传递过去，而路由在被固定的引擎处于关闭状态时会明确
     * 说明。
     */
    function selectEngine(summary, draft, engine) {
      var next = nextDraft(summary, engine, draft.enabled);
      if (engine !== '' && chainEngines(summary).indexOf(engine) >= 0) {
        next.enabled[engine] = true;
      }
      return next;
    }

    /** 更改自动参与状态，同时清掉一个不可能成立的偏好。 */
    function toggleEngine(draft, engine, enabled) {
      var next = Object.assign({}, draft, { enabled: Object.assign({}, draft.enabled) });
      next.enabled[engine] = enabled;
      if (!enabled && next.engine === engine) {
        next.engine = '';
      }
      return next;
    }

    // 一次保存到底在保存什么。固定偏好只在选择框被移动过时带上；引擎字段
    // 只在被编辑过时带上，而且只带那个引擎真正拥有的字段。若每次都把全部
    // 内容一并提交，就会固定一个没人选过的引擎，还会把卡片加载时读到的
    // 值写回文件，覆盖文件此刻的内容。
    function savePayload(summary, draft) {
      var payload = {};
      var enabled = {};
      // 只处理链上真正渲染出勾选框的引擎。没有勾选框的引擎本就没有改动的
      // 途径，把它写在这里，只可能携带一次卡片对自己做的编辑。
      chainEngines(summary).forEach((name) => {
        var before = summary.engines?.[name]?.enabled !== false;
        var after = draft.enabled?.[name] !== false;
        if (after !== before) {
          enabled[name] = after;
        }
      });
      if (Object.keys(enabled).length > 0) {
        payload.enabled = enabled;
      }
      if (draft.engine !== summary.engine) {
        payload.engine = draft.engine;
      }
      // 引擎字段的编辑目标是 editTarget，不是 engine：前者是「正在改哪个
      // 引擎」，后者是「首选哪个引擎」。两者独立，混用会让改 exa 的密钥
      // 变成改首选。
      var editName = draft.editTarget || '';
      var pristine = nextDraft(summary, editName);
      var canKey = keyed(summary, editName);
      var canModel = modelled(summary, editName);
      var canEndpoint = endpointable(summary, editName);
      var exposesTool = draft.exposeState === 'tool' || draft.exposeState === 'both';
      var edited =
        (canKey && (draft.apiKey !== '' || draft.baseURL !== pristine.baseURL)) ||
        (canModel && draft.model !== pristine.model) ||
        (canEndpoint && draft.baseURL !== pristine.baseURL) ||
        draft.proxy !== '' ||
        (exposesTool && draft.toolName !== '' && draft.toolName !== pristine.toolName);
      // 露出形态单独传递：换一种形态就是一次改动，无论有没有任何文本框
      // 动过。
      if (editName !== '' && draft.exposeState !== pristine.exposeState) {
        payload.target = editName;
        payload.expose = stateToSetting(draft.exposeState);
      }
      if (editName !== '' && edited) {
        payload.target = editName;
        if (canKey) {
          payload.apiKey = draft.apiKey;
        }
        if (canEndpoint || canKey) {
          payload.baseURL = draft.baseURL;
        }
        if (canModel) {
          payload.model = draft.model;
        }
        // 空表示「不改动文件」，与 API 密钥字段遵循同一份契约。用户从未
        // 设置过代理时，看到的就是一个空字段；若把空当成「清除代理」，就会
        // 悄悄重写一个这张卡片根本显示不出来的值。
        if (draft.proxy !== '') {
          payload.proxy = draft.proxy;
        }
        if (exposesTool && draft.toolName !== '' && draft.toolName !== pristine.toolName) {
          payload.toolName = draft.toolName;
        }
      }

      // MCP：一次只提交一个 server。代理字段用三态字符串：
      //   ''       → 不发（不改动）
      //   'direct' → 发 direct（后端存 null）
      //   URL      → 发该 URL
      // URL 也只在「与现有值不同」时才发，理由同代理字段：预填值不该
      // 让一次无关的保存重写文件。
      if (draft.mcpTarget !== '') {
        var mcpServer = (summary.mcp || {})[draft.mcpTarget] || {};
        var mcpEdited = false;
        if (draft.mcpProxy !== '') {
          payload.mcpProxy = draft.mcpProxy;
          mcpEdited = true;
        }
        var mcpUrlChanged = draft.mcpUrl !== (mcpServer.url || '');
        if (mcpUrlChanged) {
          payload.mcpUrl = draft.mcpUrl;
          mcpEdited = true;
        }
        var mcpEnabledChanged = draft.mcpEnabled !== (mcpServer.enabled !== false);
        if (mcpEnabledChanged) {
          payload.mcpEnabled = draft.mcpEnabled;
          mcpEdited = true;
        }
        if (mcpEdited) {
          payload.mcpTarget = draft.mcpTarget;
        }
      }

      // SearXNG：三态模式 + 外部地址 + 默认代理 + 上游引擎批量改动。
      //
      // 三态在文件里的写法必须落成明确的值，因为后端把「没有这个键」读作
      // 开启：
      //   off      → embedded: false          （显式关闭，而不是删键）
      //   embedded → embedded: true
      //   external → embedded: false + baseURL（外部优先，内置必须让位）
      // 只提交真的变过的部分，理由与其余字段一致。
      var searxngCurrent = (summary && summary.searxng) || {};
      var currentMode = searxngModeOf(summary);
      var externalCurrent = (summary?.engines?.searxng?.baseURL || '');

      if (typeof draft.searxngMode === 'string' && draft.searxngMode !== currentMode) {
        if (draft.searxngMode === 'external') {
          // 切到外部实例：内置让位，并带上地址（若用户已填）。
          payload.searxngEmbedded = false;
          if (draft.searxngExternalURL !== '') {
            payload.searxngExternalURL = draft.searxngExternalURL;
            payload.searxngExternalProxy = draft.searxngExternalProxy;
          }
        } else if (draft.searxngMode === 'off') {
          // 切到关闭：写显式 false。删键会被后端读回「默认开启」。
          payload.searxngEmbedded = false;
          payload.searxngExternalURL = '';
          payload.searxngExternalProxy = '';
        } else {
          // 切到内置：写显式 true，并清掉外部地址让它不再优先。
          payload.searxngEmbedded = true;
          payload.searxngExternalURL = '';
          payload.searxngExternalProxy = '';
        }
      } else if (draft.searxngMode === 'external') {
        // 模式没变，但外部地址/代理可能被改了。
        if (draft.searxngExternalURL !== externalCurrent) {
          payload.searxngExternalURL = draft.searxngExternalURL;
          payload.searxngExternalProxy = draft.searxngExternalProxy;
        } else if (draft.searxngExternalProxy !== '') {
          payload.searxngExternalProxy = draft.searxngExternalProxy;
        }
      }

      // 默认代理：变化时整段替换（空字符串 = 清掉）。
      var currentDefaultProxy = proxiesToText(searxngCurrent.outgoing);
      if (draft.searxngDefaultProxy !== currentDefaultProxy) {
        payload.searxngOutgoingProxies = proxiesFromText(draft.searxngDefaultProxy);
      }

      // 上游引擎：批量提交**变过的**条目。未变的绝不重发，这样后端那份
      // 「先复制旧规则再逐字段覆盖」的保护不会因为一次无关保存被触发。
      var rulePatch = {};
      var rulesDraft = isPlainObject(draft.searxngRules) ? draft.searxngRules : {};
      for (var ruleName of Object.keys(rulesDraft)) {
        var before = (searxngCurrent.engines || {})[ruleName] || {};
        var after = rulesDraft[ruleName] || {};
        var beforeProxy = proxiesToText(before.proxies);
        var beforeEnabled = before.disabled !== true;
        var changed = {};
        if (after.enabled !== beforeEnabled) {
          changed.enabled = after.enabled === true;
        }
        if ((after.proxy || '') !== beforeProxy) {
          changed.proxy = after.proxy || '';
        }
        if (Object.keys(changed).length > 0) {
          rulePatch[ruleName] = changed;
        }
      }
      if (Object.keys(rulePatch).length > 0) {
        payload.searxngRules = rulePatch;
      }

      return payload;
    }

    /**
     * 把文本框里的多行代理转成 `{ "all://": [...] }`。
     *
     * 卡片用一个 `all://` 键承载全部行：SearXNG 的 `all://` 本来就表示
     * 「所有协议」，而在逐引擎页面上让用户为 http 与 https 各填一遍是重复
     * 劳动。需要分协议时，用户直接在配置文件里写。
     */
    /** 判断一个值是不是普通对象（排除 null、数组、类实例）。 */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function proxiesFromText(text) {
      var lines = String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (lines.length === 0) return {};
      return { 'all://': lines.length === 1 ? lines[0] : lines };
    }

    /** 把一份 proxies 摊平成一行的代理清单，每行一个。 */
    function proxiesToText(proxies) {
      if (!proxies || typeof proxies !== 'object') return '';
      var lines = [];
      Object.keys(proxies).forEach((key) => {
        var raw = proxies[key];
        var list = Array.isArray(raw) ? raw : [raw];
        list.forEach((entry) => {
          if (typeof entry === 'string' && entry !== '') lines.push(entry);
        });
      });
      return lines.join('\n');
    }

    /**
     * 偏好列表提供的引擎。`local` 不在其中：它只抓取交给它的一个 URL，
     * 把它固定成搜索引擎，固定的是一个什么也搜不到的东西。
     *
     * 只要配置文件里还写着它，它就继续留在列表里，因为下拉框必须显示出
     * 实际配置的内容。把这一项去掉，别的引擎就会看似偏好地停在框里，
     * 那便是卡片对它正在编辑的文件撒谎。
     */
    function preferable(summary, draft) {
      if (summary.engine === 'local' || draft.engine === 'local') {
        return ENGINES;
      }
      return CHAIN_ENGINES;
    }

    /**
     * 链上为哪些引擎提供勾选框：doctor 在本机探测到已就绪的那些。在本机
     * 跑不起来的引擎不是用户必须做的决定，一行写明它跑不了，也是一行用户
     * 无法据此行动的东西。
     *
     * `readiness` 缺席意味着探测从未作答，而不是「这里什么都跑不了」的
     * 结论。这时所有搜索引擎都留在列表里：勾选框是唯一能重新打开它的
     * 办法，卡片不能拿一个自己并不知道的事实把它撤走。
     *
     * 这份列表同时也是保存时允许对 `enabled` 说些什么的范围：从未显示在
     * 屏幕上的，从未被编辑过。
     */
    function chainEngines(summary) {
      var probes = Array.isArray(summary.readiness) ? summary.readiness : null;
      if (probes === null) {
        return CHAIN_ENGINES;
      }
      return CHAIN_ENGINES.filter((name) =>
        probes.some((entry) => entry.engine === name && entry.ready === true),
      );
    }

    /**
     * 把 API 密钥字段渲染成隐藏字符的方式。
     *
     * 用真正的 password 输入框，会让 Safari 的 iCloud 钥匙串提议为这个
     * 站点开启自动填充，然后每次聚焦都弹一次气泡，而这个字段永远是空的：
     * 密钥住在配置文件里，宿主从不把它送到浏览器，只送来「是否已存了
     * 一个」。`autocomplete` 关不掉它，因为 WebKit 有意在 password 字段上
     * 忽略该属性。用 text-security 做遮罩能得到同样的隐藏字符，却从来
     * 不是 password 字段，还能让一个只属于这台机器的密钥不进同步钥匙串。
     *
     * 靠特性探测，而不是假定。属性缺失的地方，字段退回 password 输入框：
     * 一点小烦恼，比替代方案便宜——另一个方案是把某人的 API 密钥在他打字
     * 时明文呈现。
     *
     * 这是一次权衡，代价落在不在现场的人身上。password 输入框会带着一个
     * protected 状态进入无障碍树，屏幕阅读器因为它而停止回读字符。遮罩
     * 只是涂色：VoiceOver 和 NVDA 会把这个密钥读出声来，而 ARIA 没有等价
     * 手段可以还原。这里接受这个代价，因为正常使用时字段是空的，于是屏幕
     * 阅读器能读回来的，只是用户此刻正在输入的内容，而不是一个存好的
     * 机密。
     */
    function supportsTextSecurity() {
      // 抛异常的 `supports` 一律按不支持处理。规范说两个参数的形式对未知
      // 属性返回 false 而不是抛出，但这段代码运行在 render 里，一个异常
      // 会拖垮整个设置界面，而不只是损失一个字段。
      try {
        return (
          typeof CSS === 'object' &&
          CSS !== null &&
          typeof CSS.supports === 'function' &&
          CSS.supports('-webkit-text-security', 'disc') === true
        );
      } catch {
        return false;
      }
    }

    function secretFieldProps() {
      if (!supportsTextSecurity()) {
        return { type: 'password' };
      }
      return {
        type: 'text',
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        style: { WebkitTextSecurity: 'disc' },
      };
    }

    // 原生 <select> 的弹出层遵循 color-scheme，不继承 color。WebView2 在
    // 未声明配色方案时仍会把该弹出层画成浅色，所以控件必须设置一个方案，
    // 并给每个选项单独设置背景。
    function parseCssColor(value) {
      if (typeof value !== 'string') {
        return null;
      }
      const s = value.trim();
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
      if (hex) {
        const h = hex[1];
        if (h.length === 3) {
          return [
            parseInt(h.charAt(0) + h.charAt(0), 16),
            parseInt(h.charAt(1) + h.charAt(1), 16),
            parseInt(h.charAt(2) + h.charAt(2), 16),
          ];
        }
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16),
        ];
      }
      const rgb =
        /^rgba?\(\s*([0-9]*\.?[0-9]+)(?:\s*,\s*|\s+)([0-9]*\.?[0-9]+)(?:\s*,\s*|\s+)([0-9]*\.?[0-9]+)/i.exec(
          s,
        );
      if (!rgb) {
        return null;
      }
      return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    }

    function cardThemeIsDark() {
      if (typeof getComputedStyle === 'function') {
        try {
          const target = document.body || document.documentElement;
          const rgb = parseCssColor(getComputedStyle(target).color);
          if (rgb) {
            const luminance =
              0.2126 * (rgb[0] / 255) + 0.7152 * (rgb[1] / 255) + 0.0722 * (rgb[2] / 255);
            return luminance > 0.5;
          }
        } catch {
          // 读不出的计算色不是主题的答案。
        }
      }
      const media =
        typeof matchMedia === 'function'
          ? matchMedia
          : typeof window.matchMedia === 'function'
            ? window.matchMedia
            : null;
      if (typeof media === 'function') {
        try {
          if (media('(prefers-color-scheme: dark)').matches === true) {
            return true;
          }
        } catch {
          // 抛异常的 matchMedia 不是主题的答案。
        }
      }
      return false;
    }

    /**
     * 卡片样式表。
     *
     * 数值与结构照抄官方 `dsh-client-ui-settings-web-search` 的 CSS module
     * （从它的 client.js 里直接读出来的，不是猜的）：
     *
     *   .sectionTitle  font-size:14px / weight:500 / line-height:20px
     *   .field         gap:6px, padding:8px 0 12px
     *   .selector      border:.5px, radius:var(--dsw-radius-md), height:34px
     *   .hint          font-size:12px, color:label-tertiary
     *   .panel         radius:var(--dsw-radius-md), padding:0 16px
     *
     * 三条硬规则：
     * 1. 颜色一律走 `--dsw-alias-*`，一个硬编码色值都不写；
     * 2. 描边用 0.5px 而不是 1px（官方 9 处都用 0.5px，1px 会显得笨重）；
     * 3. 不自创间距令牌 —— 官方压根没有 `--dsw-space-*`，一律裸 px。
     */
    var CARD_CSS_ID = 'searchfuse-card';

    var CARD_CSS = `
/* 只做布局，不定义视觉：颜色与形状一律取自官方 token。
   四条硬约束来自实测：
   1) bg-layer-* 是半透明混色，在壁纸下与背景只有 2.11:1，所以每个行块
      必须补 0.5px 描边把轮廓画出来（border-l4 实测 9.53:1）。
   2) 壁纸不在 DOM 里，backdrop-filter 无可模糊内容，需要实底时只能用
      card-fill（唯一不透明 token）。
   3) 页脚的滚动上下文是宿主的 pageBody（overflow-y:auto），sticky 可用，
      但吸底栏必须用 card-fill 实底，否则滚过的输入框会透出来。
   4) 描边一律 0.5px（官方 9 处均为 0.5px）。 */

.sf-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 720px;
  box-sizing: border-box;
}

.sf-panel-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  margin: 0;
  color: var(--dsw-alias-label-primary);
}

.sf-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.sf-section:last-child { border-bottom: 0; padding-bottom: 0; }

.sf-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
.sf-group-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
}
.sf-hint {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}

/* 行块：card-fill 实底 + 0.5px 描边 + radius-sm。
   实测：bg-layer-* 是 color-mix 半透明，在本机壁纸主题下几乎全透明，
   文字会直接糊在壁纸上看不清（对比度 2.11:1）。card-fill 是唯一不透明
   token，所以凡是要承载文字的表面一律用它。
   红线：块内不再叠第二层底色，次级区域只用 0.5px 顶边线分隔。 */
.sf-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  box-sizing: border-box;
}
.sf-row-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  box-sizing: border-box;
}

/* 行内左侧文字：名称 + 一行说明，超长省略。 */
.sf-row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.sf-row-name {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sf-row-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内次级分隔：只用 0.5px 顶边线，不引入第二层底色。 */
.sf-divider {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  margin: 2px 0;
}

.sf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sf-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

/* 字段错误态：由字段自身渲染，不放页脚。 */
.sf-field-error {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}

.sf-footer {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 10px;
  margin-top: 8px;
  border-radius: var(--dsw-radius-sm);
  /* 必须不透明：用 bg-layer-* 会让滚过的输入框透出来叠成一团。 */
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  box-shadow: var(--dsw-elevation-soft);
}
.sf-status {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.sf-status-error { color: var(--dsw-alias-state-error-primary); }

.sf-state-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
}
.sf-state-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}

/* 上游引擎清单：定高内部滚动，锁死页面总高。 */
.sf-upstream {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sf-upstream-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sf-upstream-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 360px;
  overflow-y: auto;
  padding-right: 4px;
}
.sf-upstream-row {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  min-height: 40px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  box-sizing: border-box;
}
.sf-upstream-more {
  align-self: center;
}

.sf-empty {
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 0;
  color: var(--dsw-alias-label-tertiary);
}

/* 状态总览：三枚状态点挤在一行小卡里。壁纸背景下小字裸露会糊，
   所以给它自己的一层底色与细描边。 */
.sf-overview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.sf-overview-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}

/* 一个引擎一块：整块持 card-fill 实底，内部不再各自上底色，
   否则半透明层叠加会发灰绿，且文字对比度反复变化。 */
.sf-engine-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  box-sizing: border-box;
}
/* 块标题行在父容器里已经有一层底了，所以它自己透明、无描边。 */
.sf-engine-head {
  gap: 12px;
  padding: 0;
  background: none;
  border: 0;
}
.sf-key-field {
  padding: 6px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
/* 引擎组：组标题与组说明之后直接接引擎块，组内不留额外空白。 */
.sf-engine-group {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.sf-engine-group .sf-group-title {
  margin: 8px 0 0;
}
.sf-engine-group .sf-group-hint {
  margin: 2px 0 6px;
}
.sf-tag-inline {
  margin-left: 6px;
  vertical-align: middle;
}
.sf-engine-advanced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 2px 8px;
}
.sf-fix {
  color: var(--dsw-alias-label-tertiary);
}

/* 窄容器（老宿主的侧栏槽）：横向栅格退化为纵向堆叠，避免横向滚动条。 */
@media (max-width: 520px) {
  .sf-upstream-row { grid-template-columns: 1fr; gap: 6px; }
  .sf-footer { flex-wrap: wrap; }
}

/* 输入控件：几何照官方 .selector —— 34px 高、radius-md、0.5px 描边。
   底色用 card-fill 之上的按钮底 token，保证在壁纸下仍是实心的。 */
.sf-control {
  width: 100%;
  box-sizing: border-box;
  min-height: 34px;
  padding: 6px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
  /* 实测 bg-layer-* 与 bg-module-platform 都是半透明：壁纸会从输入框里
     透出来，字压在上面读不清。只有 card-fill 是不透明实底，所以控件
     一律用它，再用描边把它和同底的父块区分开。 */
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  outline: none;
}
.sf-control::placeholder { color: var(--dsw-alias-label-tertiary); }
.sf-textarea { min-height: 64px; resize: vertical; }

/* 就地编辑面板：整块实底，内部字段靠间距分隔，不再叠第二层底色。 */
.sf-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-card-fill);
  border: 0.5px solid var(--dsw-alias-border-l4);
  box-sizing: border-box;
}
.sf-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  border: 0.5px solid var(--dsw-alias-border-l4);
}

/* 按钮：主操作是唯一实心，其余是描边幽灵。 */
.sf-btn {
  appearance: none;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  padding: 6px 14px;
  min-height: 32px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.sf-btn:disabled { opacity: .5; cursor: default; }
.sf-btn-primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-card-fill));
  border-color: transparent;
}

/* 可交互元素一律有焦点环。--dsw-focus-ring-color 实测为空，
   所以用 state-business-primary。 */
:where(.sf-control, .sf-btn, .sf-row button):focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

/* 窄容器（老宿主的侧栏槽）：横向栅格退化为纵向堆叠，避免横向滚动条。 */
`;

    /**
     * 注入样式表。存在则更新 textContent，不存在才新建。
     *
     * 为什么不是「不存在才插入」：开发期 HMR 会重新执行工厂代码，此时
     * head 里已有标签，`!document.querySelector(...)` 判定为假，于是新
     * CSS 永远不会生效，必须手动刷新整页。这里改成更新优先的幂等写法，
     * 标签数量恒为 1，卸载时宿主能用属性选择器 100% 回收。
     */
    function injectCardCss() {
      // 逐项探测而不是只判 `typeof document`：测试与部分宿主沙箱里
      // document 存在但没有 querySelector/createElement，直接用会抛。
      if (
        typeof document === 'undefined' ||
        typeof document.querySelector !== 'function' ||
        typeof document.createElement !== 'function'
      ) {
        return;
      }
      var tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(CARD_CSS_ID) + ']');
      if (!tag) {
        tag = document.createElement('style');
        tag.dataset.pluginCss = CARD_CSS_ID;
        if (document.head && typeof document.head.appendChild === 'function') {
          document.head.appendChild(tag);
        }
      }
      tag.textContent = CARD_CSS;
    }

    // `localeRef` 是指向 dsh locale 服务的 { current } 句柄，而不是服务
    // 本身：它是可选的，还可能在卡片构建之后才到位，所以要在渲染时读取，
    // 而不是在这里捕获。服务缺席时，下面两个辅助函数都返回空，labels()
    // 走它原有的路径。
    function ConfigCard(react, ui, localeRef) {
      var h = react.createElement;
      var Input = ui.Input;
      // 官方原子组件。ponytail 这类官方风格插件的设置面板一律复用它们，
      // 不手写开关/标签：手写等于自造第二份实现，必然与宿主观感漂移。
      var Switch = ui.Switch;
      var Tag = ui.Tag;
      var Button = ui.Button;
      var SegmentedControl = ui.SegmentedControl;
      var StateDot = ui.StateDot;
      var DisclosureRow = ui.DisclosureRow;
      var PrInput = ui.Input;

      // 每张卡片只构建一次，免得 useSyncExternalStore 每次渲染都拿到新的
      // 订阅函数，从而每次都重新订阅。
      var subscribeLocale = (onChange) => {
        var locale = localeRef?.current;
        return locale ? locale.subscribe(onChange) : () => {};
      };
      var readLocale = () => {
        var locale = localeRef?.current;
        return locale ? locale.getSnapshot().active : '';
      };

      // 外壳照搬原生插件卡片，逐值对齐（描边、各层背景、12px 圆角、
      // 带旋转箭头的头部行、含放弃幽灵按钮与保存主按钮的页脚），让这张
      // 卡片读起来像内置卡片的同类，而不是借住的外来户。
      var chevron = (open) =>
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            style: {
              color: 'var(--dsw-alias-label-tertiary)',
              flex: 'none',
              transition: 'transform .16s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        );

      // `view` 是插件页提出的问题（dsh 0.1.6-alpha.2 起）：'page' 表示
      // bundle 页面上的表单，'summary' 表示一句话摘要。更老的宿主不传，
      // 得到的是可折叠卡片。
      return function ModsearchCard(props) {
        var view = props ? props.view : undefined;
        // 订阅而不是采样：语言是活设置，一张开着的卡片必须跟着切换。
        // getSnapshot 与 subscribe 是 dsh 文档里认定对
        // useSyncExternalStore 安全的那一对。这个 hook 需要 React 18 及
        // 以上；缺席的地方改为每次渲染读取一次语言，只要有什么让卡片
        // 重新渲染就仍然跟随切换。分支依据一个闭包常量，因此钩子的顺序
        // 在同一张卡片内永远不变。
        var t = labels(
          typeof react.useSyncExternalStore === 'function'
            ? react.useSyncExternalStore(subscribeLocale, readLocale)
            : readLocale(),
        );
        var openState = react.useState(false);
        var summaryState = react.useState(null);
        var draftState = react.useState(null);
        var noteState = react.useState('');
        // 页面上已经有插件标题做表单的标题，所以那里的表单一开始就是展开
        // 的：标题底下一个折叠块，等于让人把同一次点击做两遍。
        var open = view === 'page' || openState[0];
        var summary = summaryState[0];
        var draft = draftState[0];
        var note = noteState[0];

        var load = react.useCallback(() => {
          // doctor：离线自检，说明本机哪些引擎已经配置好。每次展开付一次
          // 代价，宿端缓存结果。
          fetch('/searchfuse/config?doctor=1')
            .then((r) =>
              r.json().then((body) => {
                if (!r.ok) {
                  throw new Error(body.error || '');
                }
                return body;
              }),
            )
            .then((next) => {
              summaryState[1](next);
              draftState[1](nextDraft(next, next.engine));
              noteState[1]('');
            })
            .catch((error) => {
              noteState[1](noteFrom(error, t.loadFailed));
            });
        }, []);

        react.useEffect(() => {
          if (open && summary === null) {
            load();
          }
        }, [open, summary, load]);

        // 保存之后重新读取就绪状态，这是它唯一可能在这张卡片之下发生
        // 变化的时刻：刚写进去的密钥，正是让一个引擎就绪的东西。只替换
        // 就绪列表，所以字段保留已保存的值，屏幕上也没有任何东西闪回
        // 加载状态。探测失败时保留上一个答案与已保存的提示不动：保存
        // 已经落地，后续失败不是它的消息。
        var refreshReadiness = react.useCallback((saved) => {
          fetch('/searchfuse/config?doctor=1')
            .then((r) => (r.ok ? r.json() : null))
            .then((fresh) => {
              if (fresh && Array.isArray(fresh.readiness)) {
                summaryState[1](Object.assign({}, saved, { readiness: fresh.readiness }));
              }
            })
            .catch(() => {});
        }, []);

        if (view === 'summary') {
          return t.subtitle;
        }

        // 包住单个控件的一行就是一个 label，由它给那个控件命名。包住一组
        // 控件的一行则不能这么做：label 会变成第一个控件的无障碍名称，
        // 并把整段的说明吞掉。那几行改用具名分组。
        /**
         * 渐进披露：把「不常改」的字段收进一个可展开的次级区域。
         *
         * 为什么不是一屏铺开：改动前打开卡片立刻看到 8 个以上字段，其中
         * 大半（模型、露出形态、工具名、代理）在多数使用中根本不用碰。
         * 把默认值藏起来不是隐藏信息，而是让第一次打开的人先看清主线：
         * 选引擎、填密钥、看哪些引擎可用。
         */
        var disclosure = (key, label, openFlag, children, note) => {
          var toggle = h(
            'button',
            {
              type: 'button',
              key: 'toggle-' + key,
              'aria-expanded': openFlag,
              // 让测试与宿主都能把这个折叠与卡片本身的折叠区分开。
              'data-disclosure': key,
              onClick: () => {
                var next = Object.assign({}, draft);
                next[key] = !openFlag;
                draftState[1](next);
                noteState[1]('');
              },
              className: 'sf-fold',
            },
            h('span', null, label),
            // 箭头方向就是答案：朝下意味着「还能展开」，朝上意味着
            // 「可以收起来」。前缀的 +/− 与箭头重复，去掉一个。
            h(
              'span',
              { 'aria-hidden': 'true', className: 'sf-chevron' },
              openFlag ? '\u2191' : '\u2193',
            ),
          );
          return h(
            'div',
            { key: 'disclosure-' + key },
            toggle,
            openFlag
              ? h(
                  'div',
                  { className: 'sf-fold-body' },
                  note === undefined ? null : h('p', { className: 'sf-hint' }, note),
                  children,
                )
              : null,
          );
        };

        // 一行字段。类名与结构照抄官方 settings-web-search 的 CSS module：
        // `.field`（纵向、gap 6、上下留白）里放 `.configLabel` 与控件。
        //
        // 只有包住单个控件时才用 <label>，因为 label 会成为那个控件的可访问
        // 名称；包住一组控件时必须退成具名分组，否则整段说明会被第一个控件
        // 吞掉。
        var fieldRow = (label, control, key, groupName) =>
          h(
            groupName ? 'div' : 'label',
            {
              key: key,
              role: groupName ? 'group' : undefined,
              'aria-label': groupName || undefined,
              className: 'sf-field',
            },
            label === '' ? null : h('div', { className: 'sf-label' }, label),
            control,
          );

        // 纯说明文字，不是字段，因此不占据 `.field` 的上半层。
        var hint = (text, key) =>
          text === null || text === undefined
            ? null
            : h('p', { key: key, className: 'sf-hint' }, text);

        var body = null;
        // 页脚单独一份：page 视图把它放在 sf-root 末尾（吸底），
        // 折叠卡片视图把它放进卡片内部。
        var footerBlock = null;
        if (open) {
          if (summary === null || draft === null) {
            // 摘要还不存在时，唯一能写提示的就是一次失败的加载。可折叠
            // 卡片会在下次展开时重试，但页面从不折叠，所以在出错的地方
            // 提供一个重试。
            body = h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px 0',
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontSize: '13px',
                },
              },
              h('span', { role: 'status', style: { marginRight: 'auto' } }, note || t.loading),
              note
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => {
                        noteState[1]('');
                        load();
                      },
                      style: {
                        appearance: 'none',
                        font: 'inherit',
                        fontSize: '13px',
                        lineHeight: 1.5,
                        cursor: 'pointer',
                        border: '1px solid ' + 'var(--dsw-alias-border-l2)',
                        borderRadius: '8px',
                        padding: '5px 14px',
                        background: 'none',
                        color: 'var(--dsw-alias-label-secondary)',
                      },
                    },
                    t.retry,
                  )
                : null,
            );
          } else {
            // 可用性与许可分开。doctor 说一个引擎在本机能否运行；开关说的
            // 是自动路由是否可以使用它。未启用的引擎保留它的行：取消启用
            // 不该成为撤走开关的理由，而 dsh 的 Web 用户没有终端把它撤销
            // 回去。
            const set = (key, value) => {
              var next = Object.assign({}, draft);
              next[key] = value;
              draftState[1](next);
              noteState[1]('');
            };

            // 焦点态挂在输入框上：打字时看不见光标的那个框在哪，是这类
            // 面板最常见的可访问性缺口。
            // 控件样式全部来自 `.sf-control`（官方 `.selector` 的几何与
            // token），焦点态也由 CSS 的 `:focus-visible` 处理，不再需要
            // 内联的 focusRing。这里只留行为。
            // 每个引擎的字段都必须绑到**那个引擎自己的**草稿值上，所以
            // 这里不做「隐式读 draft[key]」的便捷封装：键名是全局唯一的
            // 槽位，但引擎有九个，显式传值与回调才不会串行。
            const textInput = (value, placeholder, onEdit, extra) =>
              h(
                Input,
                Object.assign({}, extra, {
                  type: 'text',
                  value: value,
                  placeholder: placeholder,
                  onChange: (event) => onEdit(event.target.value),
                  className: 'sf-control',
                  'aria-label': extra && extra['aria-label'] ? extra['aria-label'] : placeholder,
                }),
              );
            const textField = (label, value, placeholder, onEdit, fieldId) =>
              fieldRow(label, textInput(value, placeholder, onEdit), fieldId);

            // 引擎清单：每个引擎一块，看得见全部，就地可编辑。
            //
            // 为什么不是下拉框选一个再改：一个引擎的配置（密钥、端点、代理）
            // 是**独立的一件事**，而偏好顺序是另一件事。把两者挤进同一个
            // 下拉框，用户想改 exa 的密钥就得先把 exa 设成首选，操作顺序
            // 完全倒置。清单让「看全部状态」和「改某一个」同时成立。
            //
            // 每行三段：左侧勾选框（是否参与自动路由），中间名字与就绪状态，
            // 右侧展开箭头。点名字那一侧展开编辑区，勾选框独立可点。
            // 主题与下拉弹出层配色先算好：下面的引擎行与各处 select 都要用。
            const darkCard = cardThemeIsDark();
            const optionPaint = darkCard
              ? {
                  color: 'var(--dsw-alias-label-primary, #f9fafb)',
                  background: 'var(--dsw-alias-card-fill, #212123)',
                }
              : {
                  color: 'var(--dsw-alias-label-primary-inverted, #353638)',
                  background: 'var(--dsw-alias-button-primary-fill, #f9fafb)',
                };

            // 分组：按「怎么才能用」而不是按架构。用户扫这张表时问的是
            // 「哪些我能直接用、哪些要配东西」。组内每个引擎一块，块标题
            // 行右侧放官方 Switch，低频字段收进 DisclosureRow —— 这样
            // 视觉噪音不会淹没核心操作（填密钥、切开关）。
            const ENGINE_GROUPS = [
              { key: 'keyed', title: t.groupKeyed, hint: t.groupKeyedHint, names: [] },
              { key: 'keyless', title: t.groupKeyless, hint: t.groupKeylessHint, names: [] },
              { key: 'cli', title: t.groupCli, hint: t.groupCliHint, names: [] },
            ];
            // 引擎组渲染全部可参与搜索的引擎，而不是只渲染 doctor 说就绪的。
            // 隐藏一个本机暂时跑不了的引擎，会让用户既看不到它、也无法去修
            // 它；就绪与否改用行内说明表达（见 D4）。
            const listedEngines = CHAIN_ENGINES;
            listedEngines.forEach((name) => {
              if (name === 'antigravity-cli' || name === 'grok-cli') {
                ENGINE_GROUPS[2].names.push(name);
              } else if (KEYLESS_ENGINES.indexOf(name) >= 0) {
                ENGINE_GROUPS[1].names.push(name);
              } else {
                ENGINE_GROUPS[0].names.push(name);
              }
            });

            // 改某个引擎的某个字段：若它还不是编辑目标，先把它的真值灌进
            // draft，再落这次改动。这样九个引擎共用一个 draft 也不会串。
            const editField = (name, key, value) => {
              var base =
                draft.editTarget === name ? Object.assign({}, draft) : nextDraft(summary, name);
              base.editTarget = name;
              base[key] = value;
              draftState[1](base);
              noteState[1]('');
            };

            const statusRows = listedEngines.map((name) => {
              const settings = summary.engines?.[name] || {};
              const checked = draft.enabled?.[name] !== false;
              const canKey = keyed(summary, name);
              const canModel = modelled(summary, name);
              const isReady = Array.isArray(summary.readiness)
                ? summary.readiness.some((entry) => entry.engine === name && entry.ready === true)
                : undefined;
              // 就绪状态只用三种词，不把 doctor 的整句原因抄进来 ——
              // 那是英文诊断文本，混进中文界面会被读成乱码。未就绪时
              // 单独一行给出 doctor 现成的原因与修法。
              const readinessLabel =
                isReady === undefined
                  ? ''
                  : isReady
                    ? t.readyLabel
                    : t.notReadyLabel;
              const readinessEntry = Array.isArray(summary.readiness)
                ? summary.readiness.filter((entry) => entry.engine === name)[0]
                : null;
              const fixText =
                readinessEntry && readinessEntry.ready === false
                  ? [readinessEntry.reason, readinessEntry.fix].filter(Boolean).join('；')
                  : '';
              const keyStatus = settings.hasKey === true;
              // 卡片只有一个 draft。这里刻意让每个引擎的字段都直接绑
              // draft（而不是「编辑中才绑」）—— 因为「全部展开」意味着
              // 每一行都是可编辑的，同一时刻只有一个引擎在被打字，
              // draft 天然就是那个引擎的值。点进另一个引擎时，
              // selectEditor 会先把它的真值灌进 draft。
              const isEditing = draft.editTarget === name;
              const pick = () => {
                if (isEditing) return;
                var next = nextDraft(summary, name);
                next.editTarget = name;
                // 保留用户已做的勾选与 SearXNG 草稿。
                next.enabled = Object.assign({}, draft.enabled);
                next.searxngMode = draft.searxngMode;
                next.searxngExternalURL = draft.searxngExternalURL;
                next.searxngExternalProxy = draft.searxngExternalProxy;
                next.searxngDefaultProxy = draft.searxngDefaultProxy;
                next.searxngRules = draft.searxngRules;
                next.searxngFilter = draft.searxngFilter;
                next.searxngScope = draft.searxngScope;
                draftState[1](next);
                noteState[1]('');
              };
              // 高级项里「有几项被改过」，让人不必展开也知道覆盖存在。
              const customized = [
                settings.baseURL && settings.baseURL !== '',
                settings.model && settings.model !== '',
                draft.editTarget === name && draft.proxy !== '',
                settings.hasKey === true,
              ].filter(Boolean).length;

              // 一行引擎：左侧两行文字（名字 + 状态说明），右侧官方 Switch。
              // 形态照抄官方风格插件的列表行，不自绘复选框与展开箭头。
              const headerRow = h(
                'div',
                { key: 'row-' + name, className: 'sf-row sf-engine-head', 'data-engine-row': name },
                h(
                  'div',
                  { className: 'sf-row-text' },
                  h('span', { className: 'sf-row-name' }, name),
                  h(
                    'span',
                    { className: 'sf-row-desc' },
                    [
                      readinessLabel,
                      keyStatus ? t.keySetLabel : '',
                      name === 'grok-cli' ? t.socialOnly : '',
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                ),
                h(Switch, {
                  checked,
                  label: t.autoToggleHint + ' ' + name,
                  onChange: (next) => {
                    draftState[1](toggleEngine(draft, name, next));
                    noteState[1]('');
                  },
                }),
              );

              // 密钥常显：这是这个引擎最常被改的一件事，必须零点击可粘贴。
              // 后端只回 hasKey / keySource，不回明文，所以输入框的值永远
              // 是空字符串，靠 placeholder 说明「已保存，留空即保持不变」。
              const keyRow = canKey
                ? h(
                    'div',
                    { key: 'key-' + name, className: 'sf-field sf-key-field' },
                    h(
                      'div',
                      { className: 'sf-label' },
                      t.apiKey,
                      settings.keySource === 'env'
                        ? h(Tag, { tone: 'info', className: 'sf-tag-inline' }, t.envBadge)
                        : null,
                      settings.hasKey === true && settings.keySource !== 'env'
                        ? h(Tag, { tone: 'success', className: 'sf-tag-inline' }, t.keySetLabel)
                        : null,
                    ),
                    h(Input, {
                      ...secretFieldProps(),
                      value: isEditing ? draft.apiKey : '',
                      placeholder:
                        settings.keySource === 'env'
                          ? t.keyPlaceholderEnv
                          : settings.hasKey === true
                            ? t.keyPlaceholderSet
                            : t.unset,
                      onFocus: pick,
                      onChange: (event) => editField(name, 'apiKey', event.target.value),
                      className: 'sf-control',
                      'aria-label': name + ' ' + t.apiKey,
                      'data-key-field': name,
                    }),
                    hint(t.apiKeyHint, 'keyhint-' + name),
                    // 可配密钥但本身免密钥的引擎（firecrawl / keenable /
                    // anysearch）：没存密钥时说明它本来就能用，否则那个空
                    // 输入框会被读成「必须先填密钥」。
                    KEYLESS_ENGINES.indexOf(name) >= 0 && settings.hasKey !== true
                      ? h('p', { className: 'sf-hint', key: 'keyless-' + name }, t.keylessTier)
                      : null,
                    KEYLESS_ENGINES.indexOf(name) >= 0 &&
                    settings.keySource === 'env'
                      ? h('p', { className: 'sf-hint', key: 'env-' + name }, t.envNote)
                      : null,
                  )
                : null;

              // 高级字段始终构造并交给 DisclosureRow：由组件自己决定
              // 展开时显示。若在这里按 isEditing 提前置空，折叠打开时
              // 会是一块空白。
              const editorRow = h(
                'div',
                { key: 'edit-' + name, className: 'sf-engine-advanced' },
                    // 免密钥引擎的「它本来就能用」说明放在这里：常显会和
                    // 密钥框抢注意力，而这句话只在想确认时才需要看。
                    canKey || name === 'searxng'
                      ? null
                      : h(
                          'p',
                          { key: 'keyless-' + name, className: 'sf-hint' },
                          name === 'local'
                            ? t.localNote
                            : name === 'youcom'
                              ? t.youcomNote
                              : name === 'antigravity-cli' || name === 'grok-cli'
                                ? t.cliNote
                                : t.keylessTier,
                        ),
                    // 未就绪时把 doctor 现成的原因与修法直接摆出来，
                    // 这是把技术设置页变「人性化」性价比最高的一步。
                    fixText === ''
                      ? null
                      : h('p', { key: 'fix-' + name, className: 'sf-hint sf-fix' }, fixText),
                    canKey
                      ? textField(
                          t.baseUrl,
                          isEditing ? draft.baseURL : (settings.baseURL || ''),
                          t.endpointFallback,
                          (value) => editField(name, 'baseURL', value),
                          'endpoint-' + name,
                        )
                      : null,
                    canModel
                      ? textField(
                          t.model,
                          isEditing ? draft.model : (settings.model || ''),
                          t.modelFallback,
                          (value) => editField(name, 'model', value),
                          'model-' + name,
                        )
                      : null,
                    textField(
                      t.proxyLabel,
                      isEditing ? draft.proxy : '',
                      t.proxyFallback,
                      (value) => editField(name, 'proxy', value),
                      'proxy-' + name,
                    ),
                    hint(t.proxyHint, 'proxyhint-' + name),
                    // 露出形态属于高级行为，收在编辑区底部但仍然可见，
                    // 因为它是「这个引擎以什么身份被模型看到」的答案。
                    fieldRow(
                      t.exposeTitle,
                      h(
                        'select',
                        {
                          value: isEditing ? draft.exposeState : exposeState(summary, name),
                          'data-select': 'expose',
                          onChange: (event) => editField(name, 'exposeState', event.target.value),
                          className: 'sf-control',
                          style: { appearance: 'none', colorScheme: darkCard ? 'dark' : 'light' },
                        },
                        EXPOSE_STATES.map((state) =>
                          h(
                            'option',
                            { key: state, value: state, 'data-select': 'expose', style: optionPaint },
                            t.exposeStates[state],
                          ),
                        ),
                      ),
                      'expose-' + name,
                    ),
                    hint(t.exposeHint, 'exposehint-' + name),
                    (isEditing ? draft.exposeState : exposeState(summary, name)) === 'tool' ||
                    (isEditing ? draft.exposeState : exposeState(summary, name)) === 'both'
                      ? textField(
                          t.toolNameLabel,
                          isEditing ? draft.toolName : (settings.toolName || ''),
                          toolNameFor(summary, name),
                          (value) => editField(name, 'toolName', value),
                          'toolname-' + name,
                        )
                      : null,
                    (isEditing ? draft.exposeState : exposeState(summary, name)) === 'tool' ||
                    (isEditing ? draft.exposeState : exposeState(summary, name)) === 'both'
                      ? hint(t.toolNameHint, 'toolnamehint-' + name)
                      : null,
                );

              // 「全部展开」的粒度是「分段与实体常显」，不是「每个引擎的
              // 五项低频字段全摊开」。高级字段收进官方 DisclosureRow，
              // 标题旁挂「已自定义 N 项」—— 既不被默认值刷屏，也不会漏看
              // 已经生效的覆盖项。
              const advanced = h(DisclosureRow, {
                key: 'adv-' + name,
                icon: null,
                title: customized > 0
                  ? t.advancedTitle + ' · ' + t.advancedCustomized.replace('{n}', String(customized))
                  : t.advancedTitle,
                open: isEditing,
                expandable: true,
                onToggle: () => {
                  if (!isEditing) pick();
                  else {
                    draftState[1](Object.assign({}, draft, { editTarget: '' }));
                    noteState[1]('');
                  }
                },
                children: editorRow,
              });

              return h(
                'div',
                { key: name, className: 'sf-engine-block', 'data-engine': name },
                headerRow,
                keyRow,
                advanced,
              );
            });

            const engineGroupBlock = (group) =>
              group.names.length === 0
                ? null
                : h(
                    'div',
                    { key: group.key, className: 'sf-engine-group' },
                    h('h5', { className: 'sf-group-title' }, group.title),
                    h('p', { className: 'sf-group-hint' }, group.hint),
                    group.names.map((name) => statusRows[listedEngines.indexOf(name)]),
                  );

            // 保存失败是一句需要被打断的报错，成功只是确认。两者的
            // aria-live 强度不同，所以先算出来给页脚用。
            const noteIsError =
              note !== '' && note !== t.saving && note !== t.saved;
            // 与 savePayload 衡量的是同一份列表，所以按钮绝不会在一次
            // 保存不会携带的改动上亮起来。
            const dirty =
              draft.engine !== summary.engine ||
              Object.keys(draft.enabled || {}).some(
                (name) =>
                  (draft.enabled[name] !== false) !== (summary.engines?.[name]?.enabled !== false),
              ) ||
              draft.apiKey !== '' ||
              (draft.baseURL !== '' && draft.baseURL !== (summary.engines?.[summary.engine] || {}).baseURL) ||
              draft.model !== '' ||
              draft.proxy !== '' ||
              draft.toolName !== '';

            // ── 状态总览 ─────────────────────────────────────────
            //
            // 打开设置页的第一个问题是「我配好了没有」。先给一句结论，
            // 再往下改，比一上来就给下拉框更贴近真实使用顺序。
            const readinessArr = Array.isArray(summary.readiness) ? summary.readiness : null;
            const readyEngines = readinessArr
              ? readinessArr.filter((entry) => entry.ready === true).length
              : null;
            const mcpEnabled = Object.keys(summary.mcp || {}).filter(
              (name) => (summary.mcp[name] || {}).enabled !== false,
            ).length;
            const searxngNow = draft.searxngMode || searxngModeOf(summary);
            const overviewRow = h(
              'div',
              { key: 'overview', className: 'sf-row sf-overview' },
              h(
                'span',
                { className: 'sf-overview-item' },
                h(StateDot, {
                  state: readyEngines === null ? 'ongoing' : readyEngines > 0 ? 'done' : 'warning',
                }),
                h(
                  'span',
                  { className: 'sf-overview-text' },
                  readyEngines === null
                    ? t.autoUnknown
                    : readyEngines > 0
                      ? t.overviewEngines.replace('{n}', String(readyEngines))
                      : t.overviewNoEngines,
                ),
              ),
              h(
                'span',
                { className: 'sf-overview-item' },
                h(StateDot, {
                  state: searxngNow === 'off' ? 'idle' : 'done',
                }),
                h(
                  'span',
                  { className: 'sf-overview-text' },
                  searxngNow === 'embedded'
                    ? t.overviewSearxngEmbedded
                    : searxngNow === 'external'
                      ? t.overviewSearxngExternal
                      : t.overviewSearxngOff,
                ),
              ),
              h(
                'span',
                { className: 'sf-overview-item' },
                h(StateDot, { state: mcpEnabled > 0 ? 'done' : 'idle' }),
                h(
                  'span',
                  { className: 'sf-overview-text' },
                  t.overviewMcp.replace('{n}', String(mcpEnabled)),
                ),
              ),
            );

            // ── 搜索策略 ─────────────────────────────────────────
            //
            // 首选引擎是全局偏好，不属于任何单个引擎的字段，因此单独成段。
            const strategyBlock = h(
              'div',
              { key: 'strategy', className: 'sf-section' },
              h('h4', { className: 'sf-section-title' }, t.strategyTitle),
              h('p', { className: 'sf-section-hint' }, t.strategyHint),
              fieldRow(
                t.engine,
                h(
                  'select',
                  {
                    value: draft.engine,
                    onChange: (event) => {
                      draftState[1](selectEngine(summary, draft, event.target.value));
                      noteState[1]('');
                    },
                    className: 'sf-control',
                    style: { appearance: 'none', colorScheme: darkCard ? 'dark' : 'light' },
                  },
                  [h('option', { key: '', value: '', style: optionPaint }, t.automatic)].concat(
                    preferable(summary, draft).map((name) =>
                      h(
                        'option',
                        { key: name, value: name, style: optionPaint },
                        KEYLESS_ENGINES.indexOf(name) >= 0 ? name + t.keylessSuffix : name,
                      ),
                    ),
                  ),
                ),
                'engine',
              ),
            );

            body = h(
              'div',
              { key: 'engine-body' },
              overviewRow,
              strategyBlock,
              h(
                'div',
                { key: 'engine-section', className: 'sf-section' },
                h('h4', { className: 'sf-section-title' }, t.engine),
                // 就绪状态是一句提示，不是筛选：引擎表照常全列，这行只
                // 说明「现在没有一个能直接搜」。
                readyEngines === 0
                  ? h('p', { className: 'sf-section-hint' }, t.autoEmpty)
                  : null,
                readinessArr === null
                  ? h('p', { className: 'sf-section-hint' }, t.autoUnknown)
                  : null,
                ENGINE_GROUPS.map((group) => engineGroupBlock(group)),
              ),
            );

            // 页脚不属于 body：它要作为 sf-root 的最后一个子元素，才能
            // 一直吸在滚动容器底部，而不是只在滚到内容末尾时才吸住。
            footerBlock = h(
              'div',
              {
                key: 'footer',
                className: 'sf-footer',
              },
                h(
                  'span',
                  {
                    // 成功与进行中用 polite，屏幕阅读器读完当前句子再插入；
                    // 失败用 alert，因为它需要立刻打断，否则用户会继续
                    // 以为「保存成功了」。
                    role: noteIsError ? 'alert' : 'status',
                    'aria-live': noteIsError ? 'assertive' : 'polite',
                    className: noteIsError ? 'sf-status sf-status-error' : 'sf-status',
                  },
                  note,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !dirty || note === t.saving,
                    onClick: () => {
                      draftState[1](nextDraft(summary, summary.engine));
                      noteState[1]('');
                    },
                    // 次要动作：官方 `.ghost` 形态，描边 + 透明底。
                    className: 'sf-btn',
                  },
                  t.discard,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !dirty || note === t.saving,
                    onClick: () => {
                      noteState[1](t.saving);
                      fetch('/searchfuse/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(savePayload(summary, draft)),
                      })
                        .then((r) =>
                          r.json().then((payload) => {
                            if (!r.ok) {
                              throw new Error(payload.error || '');
                            }
                            return payload;
                          }),
                        )
                        .then((next) => {
                          // 保存的响应里没有 doctor 的这次运行，所以屏幕上
                          // 已有的状态保持不变，直到下面那次新探测作答。
                          next.readiness = summary.readiness;
                          summaryState[1](next);
                          draftState[1](nextDraft(next, next.engine));
                          noteState[1](t.saved);
                          refreshReadiness(next);
                        })
                        .catch((error) => {
                          noteState[1](noteFrom(error, t.saveFailed));
                        });
                    },
                    // 主动作：官方 `.primary` 形态，实心反相。
                    className: 'sf-btn sf-btn-primary',
                  },
                  t.save,
                ),
              );
          }
        }

        // MCP 区块。结构照抄官方 settings-web-search：`section` + `h4`
        // 标题 + `.panel` 包裹逐项，每项用 `.row`（名字 + 状态徽标）。
        var mcpBlock = null;
        var mcpServers = (summary && summary.mcp) || {};
        var mcpNames = Object.keys(mcpServers);
        if (mcpNames.length > 0) {
          var mcpRows = mcpNames.map((name) => {
            var server = mcpServers[name];
            var isOpen = draft.mcpTarget === name;
            var editor = isOpen
              ? h(
                  'div',
                  { key: 'mcp-edit-' + name, className: 'sf-panel', style: { marginBottom: '10px' } },
                  h(
                    'div',
                    { className: 'sf-field' },
                    h('div', { className: 'sf-label' }, t.mcpUrl),
                    h('input', {
                      type: 'text',
                      value: draft.mcpUrl,
                      placeholder: server.url || '',
                      className: 'sf-control',
                      'aria-label': t.mcpUrl,
                      onChange: (event) =>
                        draftState[1](Object.assign({}, draft, { mcpUrl: event.target.value })),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'sf-field' },
                    h('div', { className: 'sf-label' }, t.mcpProxy),
                    h('input', {
                      type: 'text',
                      value: draft.mcpProxy,
                      placeholder: t.mcpProxyHint,
                      className: 'sf-control',
                      'aria-label': t.mcpProxy,
                      onChange: (event) =>
                        draftState[1](Object.assign({}, draft, { mcpProxy: event.target.value })),
                    }),
                    h('p', { className: 'sf-hint' }, t.mcpProxyHint),
                  ),
                  h(
                    'div',
                    { className: 'sf-field' },
                    h(
                      'label',
                      { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                      h('input', {
                        type: 'checkbox',
                        className: 'sf-check',
                        checked: draft.mcpEnabled,
                        onChange: (event) =>
                          draftState[1](Object.assign({}, draft, { mcpEnabled: event.target.checked })),
                      }),
                      h('span', { className: 'sf-label' }, t.mcpEnabled),
                    ),
                  ),
                )
              : null;

            return h(
              'div',
              { key: 'mcp-' + name },
              h(
                'div',
                { className: 'sf-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-expanded': isOpen,
                    onClick: () => draftState[1](selectMcp(summary, draft, isOpen ? '' : name)),
                    className: 'sf-row-title',
                  },
                  h('span', { className: 'sf-row-name' }, name),
                  server.isDefault
                    ? h('span', { className: 'sf-tag' }, t.mcpDefault)
                    : null,
                  h(
                    'span',
                    { className: 'sf-tag', style: { borderColor: 'transparent' } },
                    server.enabled === false ? t.mcpDisabled : server.url || '',
                  ),
                ),
                h(
                  'span',
                  { 'aria-hidden': 'true', className: 'sf-chevron' },
                  isOpen ? '\u2191' : '\u2193',
                ),
              ),
              editor,
            );
          });

          mcpBlock = h(
            'section',
            { key: 'mcp-section', className: 'sf-section', 'aria-labelledby': 'sf-mcp-title' },
            h('h4', { id: 'sf-mcp-title', className: 'sf-section-title' }, t.mcpSection),
            h('p', { className: 'sf-section-hint' }, t.mcpHint),
            h('div', { style: { marginTop: '8px' } }, mcpRows),
          );
        }

        // SearXNG 段。三态互斥 + 上游引擎定高列表 + 命名网络（高级）。
        //
        // 为什么是三态而不是「内置开关 + 外部地址两个独立输入」：两者同时
        // 有值时无法表达谁优先，那是个非法状态。收敛成一个选择后，界面
        // 任何时候都只有一种确定的语义。
        var searxngBlock = null;
        if (summary && summary.searxng) {
          var section = summary.searxng || {};
          var networkNames = Object.keys(section.networks || {});
          var upstreamConfigured = Object.keys(section.engines || {});

          // 上游引擎清单：内置实例自带的一份完整列表（实测 352 个，默认
          // 启用 121 个）。卡片不内嵌这份清单——它属于实例运行时状态，
          // 不属于用户配置；这里只列「用户已经改过的」那些，并给一个
          // 添加框让用户按名字点名。
          var ruleNames = Object.keys(draft.searxngRules || {});
          var filterText = String(draft.searxngFilter || '').trim().toLowerCase();
          var visibleRules = ruleNames.filter((n) =>
            filterText === '' ? true : n.toLowerCase().includes(filterText),
          );
          // 「已修改」档：与文件里的值不同的那些。
          var modifiedNames = ruleNames.filter((n) => {
            var before = (section.engines || {})[n] || {};
            var after = (draft.searxngRules || {})[n] || {};
            var proxyChanged = (after.proxy || '') !== proxiesToText(before.proxies);
            var enabledChanged = (after.enabled === true) === (before.disabled === true);
            return proxyChanged || enabledChanged;
          });
          if (draft.searxngScope === 'modified') {
            visibleRules = visibleRules.filter((n) => modifiedNames.includes(n));
          }
          // 已修改的置顶，便于核对「我到底动了什么」。
          visibleRules.sort((a, b) => {
            var am = modifiedNames.includes(a) ? 0 : 1;
            var bm = modifiedNames.includes(b) ? 0 : 1;
            return am - bm || a.localeCompare(b);
          });

          var scopeOf = (name) => {
            var before = (section.engines || {})[name] || {};
            var parts = [];
            if (before.network) parts.push(t.searxngNetworkBadge + ' ' + before.network);
            if (before.using_tor_proxy) parts.push(t.searxngTorBadge);
            if (before.disabled === true && modifiedNames.indexOf(name) < 0) {
              parts.push(t.searxngEngineDisabled);
            }
            return parts.join(' · ');
          };

          var setRule = (name, patch) => {
            var nextRules = Object.assign({}, draft.searxngRules);
            var current = Object.assign({ enabled: true, proxy: '' }, nextRules[name] || {});
            nextRules[name] = Object.assign({}, current, patch);
            draftState[1](Object.assign({}, draft, { searxngRules: nextRules }));
            noteState[1]('');
          };

          // 一行上游引擎：名字（带非默认标记）| 代理 | 开关。
          // 单行 40px，横向栅格；窄容器下退化为纵向（见 CSS 的 520px 断点）。
          var upstreamRow = (name) => {
            var rule = (draft.searxngRules || {})[name] || { enabled: true, proxy: '' };
            var badges = scopeOf(name);
            return h(
              'div',
              { key: 'up-' + name, className: 'sf-upstream-row' },
              h(
                'div',
                { className: 'sf-row-text' },
                h('span', { className: 'sf-row-name' }, name),
                badges === '' ? null : h('span', { className: 'sf-row-desc' }, badges),
              ),
              h(PrInput, {
                type: 'text',
                value: rule.proxy || '',
                placeholder: t.searxngFollowDefault,
                'aria-label': name + ' ' + t.searxngExternalProxy,
                className: 'sf-control',
                onChange: (event) => setRule(name, { proxy: event.target.value }),
              }),
              h(Switch, {
                checked: rule.enabled !== false,
                label: name + ' ' + t.searxngEngineDisabled,
                onChange: (next) => setRule(name, { enabled: next }),
              }),
            );
          };

          // 三态选择：官方 SegmentedControl（互斥、自带 tab 键盘语义）。
          var modeOptions = [
            { value: 'off', label: t.searxngModeOff },
            { value: 'embedded', label: t.searxngModeEmbedded },
            { value: 'external', label: t.searxngModeExternal },
          ];

          // 内置实例面板：默认代理 + 上游引擎清单。
          var embeddedPanel =
            draft.searxngMode === 'embedded'
              ? h(
                  'div',
                  { className: 'sf-field' },
                  h('div', { className: 'sf-label' }, t.searxngDefaultProxy),
                  h('textarea', {
                    rows: 2,
                    value: draft.searxngDefaultProxy || '',
                    placeholder: 'http://127.0.0.1:7890',
                    className: 'sf-control sf-textarea',
                    'aria-label': t.searxngDefaultProxy,
                    onChange: (event) =>
                      draftState[1](
                        Object.assign({}, draft, { searxngDefaultProxy: event.target.value }),
                      ),
                  }),
                  h('p', { className: 'sf-hint' }, t.searxngDefaultProxyHint),

                  h(
                    'div',
                    { className: 'sf-upstream', style: { marginTop: '8px' } },
                    h('div', { className: 'sf-label' }, t.searxngUpstreamTitle),
                    h(
                      'div',
                      { className: 'sf-upstream-toolbar' },
                      PrInput,
                      // 过滤框：官方 Input，按名字实时过滤。
                      h(PrInput, {
                        type: 'text',
                        value: draft.searxngFilter || '',
                        placeholder: t.searxngFilterPlaceholder,
                        'aria-label': t.searxngFilterPlaceholder,
                        onChange: (event) =>
                          draftState[1](
                            Object.assign({}, draft, { searxngFilter: event.target.value }),
                          ),
                      }),
                      // 档位：已修改 / 已启用 / 全部，用官方 Button.toolbar。
                      h(
                        Button,
                        {
                          variant: 'toolbar',
                          size: 'sm',
                          onClick: () =>
                            draftState[1](Object.assign({}, draft, { searxngScope: 'modified' })),
                        },
                        t.searxngScopeModified + ' (' + modifiedNames.length + ')',
                      ),
                      h(
                        Button,
                        {
                          variant: 'toolbar',
                          size: 'sm',
                          onClick: () =>
                            draftState[1](Object.assign({}, draft, { searxngScope: 'enabled' })),
                        },
                        t.searxngScopeEnabled + ' (' + ruleNames.length + ')',
                      ),
                    ),
                    visibleRules.length === 0
                      ? h(
                          'p',
                          { className: 'sf-empty' },
                          t.searxngNetworkEmpty,
                        )
                      : h(
                          'div',
                          {
                            className: 'sf-upstream-list',
                            role: 'group',
                            'aria-label': t.searxngUpstreamTitle,
                          },
                          visibleRules.slice(0, 60).map(upstreamRow),
                          visibleRules.length > 60
                            ? h(
                                'div',
                                { className: 'sf-upstream-more' },
                                h(
                                  Button,
                                  {
                                    variant: 'ghost',
                                    size: 'sm',
                                    onClick: () =>
                                      draftState[1](
                                        Object.assign({}, draft, { searxngShowAll: true }),
                                      ),
                                  },
                                  t.searxngShowMore.replace('{n}', String(visibleRules.length - 60)),
                                ),
                              )
                            : null,
                        ),
                    // 按名字添加一条规则：上游清单随版本变化，不做白名单。
                    h(
                      'div',
                      { className: 'sf-adder' },
                      h(PrInput, {
                        type: 'text',
                        value: draft.searxngEngineName || '',
                        placeholder: t.searxngEngineName,
                        'aria-label': t.searxngEngineName,
                        onChange: (event) =>
                          draftState[1](
                            Object.assign({}, draft, { searxngEngineName: event.target.value }),
                          ),
                      }),
                      h(
                        Button,
                        {
                          variant: 'outline',
                          size: 'sm',
                          onClick: () => {
                            var name = String(draft.searxngEngineName || '').trim();
                            if (name === '') return;
                            var nextRules = Object.assign({}, draft.searxngRules);
                            if (nextRules[name] === undefined) {
                              nextRules[name] = {
                                enabled: ((section.engines || {})[name] || {}).disabled !== true,
                                proxy: proxiesToText(((section.engines || {})[name] || {}).proxies),
                              };
                            }
                            draftState[1](
                              Object.assign({}, draft, {
                                searxngRules: nextRules,
                                searxngEngineName: '',
                              }),
                            );
                            noteState[1]('');
                          },
                        },
                        t.searxngEngineAdd,
                      ),
                    ),
                  ),
                )
              : null;

          // 外部实例面板：地址 + 代理。
          var externalPanel =
            draft.searxngMode === 'external'
              ? h(
                  'div',
                  { className: 'sf-field' },
                  h('div', { className: 'sf-label' }, t.searxngExternalURL),
                  h(PrInput, {
                    type: 'text',
                    value: draft.searxngExternalURL || '',
                    placeholder: 'https://searx.example.com',
                    'aria-label': t.searxngExternalURL,
                    className: 'sf-control',
                    onChange: (event) =>
                      draftState[1](
                        Object.assign({}, draft, { searxngExternalURL: event.target.value }),
                      ),
                  }),
                  h(
                    'div',
                    { className: 'sf-label', style: { marginTop: '8px' } },
                    t.searxngExternalProxy,
                  ),
                  h(PrInput, {
                    type: 'text',
                    value: draft.searxngExternalProxy || '',
                    placeholder: t.searxngFollowDefault,
                    'aria-label': t.searxngExternalProxy,
                    className: 'sf-control',
                    onChange: (event) =>
                      draftState[1](
                        Object.assign({}, draft, { searxngExternalProxy: event.target.value }),
                      ),
                  }),
                )
              : null;

          searxngBlock = h(
            'section',
            { key: 'sx-section', className: 'sf-section', 'aria-labelledby': 'sf-sx-title' },
            h('h4', { id: 'sf-sx-title', className: 'sf-title' }, t.searxngTitle),
            h('p', { className: 'sf-hint' }, t.searxngModeHint),
            h(
              'div',
              { className: 'sf-field' },
              h('div', { className: 'sf-label' }, t.searxngModeLabel),
              h(SegmentedControl, {
                id: 'sf-searxng-mode',
                label: t.searxngModeLabel,
                value: draft.searxngMode,
                options: modeOptions,
                onChange: (next) => {
                  draftState[1](Object.assign({}, draft, { searxngMode: next }));
                  noteState[1]('');
                },
              }),
            ),
            embeddedPanel,
            externalPanel,
            // 命名网络：低频，收进一个折叠里（这是「全部展开」的唯一例外，
            // 因为它属于「高级」语义，且条目数不固定）。
            h(DisclosureRow, {
              icon: null,
              title: t.searxngAdvanced,
              open: Boolean(draft.searxngShowNetworks),
              expandable: true,
              onToggle: () =>
                draftState[1](
                  Object.assign({}, draft, { searxngShowNetworks: !draft.searxngShowNetworks }),
                ),
              children: [
                h('p', { className: 'sf-hint', key: 'net-hint' }, t.searxngAdvancedHint),
                networkNames.length === 0
                  ? h('p', { className: 'sf-empty', key: 'net-empty' }, t.searxngNetworkEmpty)
                  : null,
              ].concat(
                networkNames.map((name) => {
                  var network = (section.networks || {})[name] || {};
                  var summaryLine = proxiesToText(network.proxies).replace(/\n/g, ', ');
                  return h(
                    'div',
                    { key: 'net-' + name, className: 'sf-row' },
                    h(
                      'div',
                      { className: 'sf-row-text' },
                      h('span', { className: 'sf-row-name' }, name),
                      h(
                        'span',
                        { className: 'sf-row-desc' },
                        summaryLine || t.searxngNoProxySet,
                      ),
                    ),
                  );
                }),
              ),
            }),
          );
        }

        if (view === 'page') {
          // 不做整页大卡片。
          //
          // 官方风格插件的设置面板根容器是「无背景无边框，只靠 gap 与
          // 各段的下边线建立节奏」，每一行自己持实底。铺一张大卡片会让
          // 这段表单读起来像嵌进页面的外来面板，而官方区块之间只有节奏
          // 差异。
          //
          // 页脚是 sf-root 的直接子元素：只有这样它才会在整页滚动期间
          // 一直吸在滚动容器底部（宿主的 pageBody 是 overflow-y:auto）。
          return h(
            'div',
            { className: 'sf-root' },
            h('h4', { className: 'sf-panel-title' }, t.section),
            body,
            mcpBlock,
            searxngBlock,
            footerBlock,
          );
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid ' + 'var(--dsw-alias-border-l2)',
              // 折叠卡片同用卡片的填充 token；收起时退回 layer-3，
              // 让「打开着」比「收起来」高一层。
              background: open
                ? 'var(--dsw-alias-card-fill)'
                : 'var(--dsw-alias-bg-layer-3)',
              borderRadius: '12px',
              transition: 'border-color .16s, background .16s',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: () => {
                openState[1](!open);
              },
              style: {
                appearance: 'none',
                width: '100%',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'none',
                border: 0,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 16px',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
              h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-tertiary)',
                    fontSize: '13px',
                    lineHeight: 1.5,
                  },
                },
                t.subtitle,
              ),
            ),
            chevron(open),
          ),
          open
            ? h(
                'div',
                { style: { margin: '0 16px', paddingBottom: '8px' } },
                body,
                mcpBlock,
                searxngBlock,
                footerBlock,
              )
            : null,
        );
      };
    }

    function registerCard(ctx) {
      // 在 cordis 里伸手去拿一个未声明的服务会抛异常，所以每个可选依赖
      // 各走一次自己范围的 ctx.inject：闭包在服务存在的地方运行，在不存在
      // 的地方绝不运行，与宿主半边取 webServer 的做法完全一致。
      if (typeof ctx.inject !== 'function') {
        return;
      }

      // dsh 的语言服务占用自己的一次 inject，并填充一个卡片稍后读取的
      // 句柄。把它与 slots 并列写在一起，比没用更糟：ctx.inject 会等待它
      // 点名的每一个服务，于是在一个从不提供 locale 的宿主上，卡片根本
      // 不会注册。放在这里，服务缺失只是让句柄空着，卡片退回页面语言。
      var localeRef = { current: null };
      ctx.inject(['locale'], (scope) => {
        localeRef.current = scope.locale;
        if (typeof scope.effect === 'function') {
          scope.effect(
            () => () => {
              localeRef.current = null;
            },
            'modsearch: locale handle',
          );
        }
      });

      ctx.inject(['slots'], (scope) => {
        // 卡片与它的路由同生共死：宿主路由关掉时（settingsCard: false，
        // 或没有 web profile），卡片只能渲染一个错误，而那不是「关掉一项
        // 功能」的含义。任何响应都证明路由存在；只有 404 或网络失败才
        // 算作不存在。
        fetch('/searchfuse/config')
          .then((response) => {
            if (response.status === 404) {
              return;
            }
            try {
              mountCard(scope, localeRef);
            } catch (error) {
              console.error(`[searchfuse] settings card skipped: ${error}`);
            }
          })
          .catch(() => {});
      });
    }

    function mountCard(ctx, localeRef) {
      var react;
      try {
        react = require('react');
      } catch (error) {
        console.error(`[searchfuse] settings card skipped: ${error}`);
        return;
      }
      var ui = require('@deepseek-ai/dsh-client-ui-primitives');
      var Card = ConfigCard(react, ui, localeRef);
      // slots.inject 会等待 slot 被声明，所以每个宿主只填它自己有的那个，
      // 另一个的等待永不触发：dsh 0.1.6-alpha.2 起的宿主只声明插件页那个，
      // 更老的只声明设置页那个。
      ctx.slots.inject('plugins.bundle.config', function* () {
        yield ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, Card);
      });
      ctx.slots.inject('settings.plugin.item', function* () {
        // rc.6 的列表 slot 用 id，rc.7 的键控 slot 用 key：一个客户端同时
        // 服务两者，而 key 必须与宿主半边注册的设置命名空间一致，否则卡片
        // 会静默地永不渲染。
        yield ctx.slots.register(
          { name: 'settings.plugin.item', id: 'modsearch', key: 'modsearch', order: 31 },
          Card,
        );
      });
    }

    function apply(ctx) {
      // 样式先注入：卡片渲染前必须已经存在，否则第一帧会闪一下无样式
      // 的裸布局。
      injectCardCss();
      registerCard(ctx);
    }

    exports.apply = apply;
    // 仅供本仓库的测试使用；不属于插件契约。
    exports.__card = {
      nextDraft: nextDraft,
      selectEngine: selectEngine,
      toggleEngine: toggleEngine,
      savePayload: savePayload,
      secretFieldProps: secretFieldProps,
      ConfigCard: ConfigCard,
    };
    // `slots` 与 `locale` 都是可选的，所以这里不要求任何一个：registerCard
    // 各自用一次自范围的 inject 取用。
    exports.inject = [];
    return module.exports;
  },
});
