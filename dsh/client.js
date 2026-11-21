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
        // MCP 的编辑区：`mcpTarget` 是当前展开的 server，其余是该 server
        // 的待提交值。空字段表示「不改动文件」，与代理字段的契约一致。
        mcpTarget: '',
        mcpUrl: '',
        mcpProxy: '',
        mcpEnabled: true,
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
      var pristine = nextDraft(summary, draft.engine);
      var canKey = keyed(summary, draft.engine);
      var canModel = modelled(summary, draft.engine);
      var canEndpoint = endpointable(summary, draft.engine);
      var exposesTool = draft.exposeState === 'tool' || draft.exposeState === 'both';
      var edited =
        (canKey && (draft.apiKey !== '' || draft.baseURL !== pristine.baseURL)) ||
        (canModel && draft.model !== pristine.model) ||
        (canEndpoint && draft.baseURL !== pristine.baseURL) ||
        draft.proxy !== '' ||
        (exposesTool && draft.toolName !== '' && draft.toolName !== pristine.toolName);
      // 露出形态单独传递：换一种形态就是一次改动，无论有没有任何文本框
      // 动过。
      if (draft.engine !== '' && draft.exposeState !== pristine.exposeState) {
        payload.target = draft.engine;
        payload.expose = stateToSetting(draft.exposeState);
      }
      if (draft.engine !== '' && edited) {
        payload.target = draft.engine;
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

      return payload;
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

    // `localeRef` 是指向 dsh locale 服务的 { current } 句柄，而不是服务
    // 本身：它是可选的，还可能在卡片构建之后才到位，所以要在渲染时读取，
    // 而不是在这里捕获。服务缺席时，下面两个辅助函数都返回空，labels()
    // 走它原有的路径。
    function ConfigCard(react, ui, localeRef) {
      var h = react.createElement;
      var Input = ui.Input;

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
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
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
        var fieldRow = (label, control, key, groupName) =>
          h(
            groupName ? 'div' : 'label',
            {
              key: key,
              role: groupName ? 'group' : undefined,
              'aria-label': groupName || undefined,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              },
            },
            h(
              'div',
              { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } },
              label,
            ),
            control,
          );

        var hint = (text, key) =>
          fieldRow(
            '',
            h(
              'div',
              {
                style: {
                  fontSize: '13px',
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                },
              },
              text,
            ),
            key,
          );

        var body = null;
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
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
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
                        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                        borderRadius: '8px',
                        padding: '5px 14px',
                        background: 'none',
                        color: 'var(--dsw-alias-label-secondary, inherit)',
                      },
                    },
                    t.retry,
                  )
                : null,
            );
          } else {
            const canKey = keyed(summary, draft.engine);
            const canModel = modelled(summary, draft.engine);
            const current = summary.engines?.[draft.engine] || { hasKey: false, keySource: null };
            const pristine = nextDraft(summary, draft.engine);
            // 可用性与许可分开。doctor 说一个引擎在本机能否运行，只有那些
            // 获得一行。勾选框说自动路由是否可以使用它。未勾选的引擎保留
            // 它的行：取消勾选不该成为撤走勾选框的理由，而 dsh 的 Web 用户
            // 没有终端可以把它撤销回去。
            const chain = chainEngines(summary);
            // 与 savePayload 衡量的是同一份列表，所以按钮绝不会在一次
            // 保存不会携带的改动上亮起来。
            const exposesTool =
              draft.exposeState === 'tool' || draft.exposeState === 'both';
            const dirty =
              draft.engine !== summary.engine ||
              draft.exposeState !== pristine.exposeState ||
              draft.proxy !== '' ||
              (exposesTool &&
                draft.toolName !== '' &&
                draft.toolName !== pristine.toolName) ||
              (canKey && (draft.apiKey !== '' || draft.baseURL !== pristine.baseURL)) ||
              (canModel && draft.model !== pristine.model) ||
              chain.some(
                (name) =>
                  (draft.enabled?.[name] !== false) !==
                  (summary.engines?.[name]?.enabled !== false),
              );

            const set = (key, value) => {
              var next = Object.assign({}, draft);
              next[key] = value;
              draftState[1](next);
              noteState[1]('');
            };

            const inputProps = (key, placeholder) => ({
              value: draft[key],
              placeholder: placeholder,
              onChange: (event) => {
                set(key, event.target.value);
              },
            });
            const textField = (label, key, placeholder) =>
              fieldRow(
                label,
                h(Input, Object.assign(inputProps(key, placeholder), { type: 'text' })),
                key,
              );
            // 用独立的函数，而不是让调用方自己拼对的 `type` 字符串。一个
            // 用 `===` 比较的哨兵值会失效开放：一次笔误，或后来某次编辑
            // 传进 'text'，密钥就会明文渲染，而所有测试依旧全绿。
            const secretField = (label, key, placeholder) =>
              fieldRow(
                label,
                h(Input, Object.assign(inputProps(key, placeholder), secretFieldProps())),
                key,
              );

            const chainNote = !Array.isArray(summary.readiness)
              ? t.autoUnknown
              : chain.length === 0
                ? t.autoEmpty
                : '';
            const statusRows = chain.map((name) => {
              const checked = draft.enabled?.[name] !== false;
              return h(
                'label',
                {
                  key: name,
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    minHeight: '32px',
                    padding: '4px 10px',
                    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    borderRadius: '8px',
                    background: checked
                      ? 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.08))'
                      : 'transparent',
                    cursor: 'pointer',
                    fontSize: '13px',
                  },
                },
                // 不加 aria-label。这个 label 恰好包住一个控件，它的文本
                // 就是复选框的无障碍名称，而那段文本正是整行：只写引擎名
                // 的 aria-label 会用盒子名称盖过 label，并让旁边的附注
                // 不被读出。
                h('input', {
                  type: 'checkbox',
                  checked,
                  onChange: (event) => {
                    draftState[1](toggleEngine(draft, name, event.target.checked));
                    noteState[1]('');
                  },
                }),
                h('span', null, name),
                // grok-cli 只承担社交搜索这一个角色：它从不加入网页搜索的
                // 故障转移，而一排搜索引擎里一个没有任何标记的勾选框，会
                // 暗示它确实会加入。
                name === 'grok-cli'
                  ? h(
                      'span',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                          fontSize: '12px',
                        },
                      },
                      t.socialOnly,
                    )
                  : null,
              );
            });

            const darkCard = cardThemeIsDark();
            const optionPaint = darkCard
              ? { color: '#f2f2f2', background: '#23262a' }
              : { color: '#23262a', background: '#f2f2f2' };
            body = h(
              'div',
              null,
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
                    style: {
                      appearance: 'none',
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '13px',
                      colorScheme: darkCard ? 'dark' : 'light',
                    },
                  },
                  [h('option', { key: '', value: '', style: optionPaint }, t.automatic)].concat(
                    preferable(summary, draft).map((name) =>
                      h(
                        'option',
                        { key: name, value: name, style: optionPaint },
                        KEYLESS_ENGINES.indexOf(name) >= 0 ? `${name}${t.keylessSuffix}` : name,
                      ),
                    ),
                  ),
                ),
                'engine',
              ),
              draft.engine === ''
                ? hint(t.pickToConfigure, 'unpinned')
                : canKey
                  ? secretField(t.apiKey, 'apiKey', current.hasKey ? t.stored : t.unset)
                  : hint(
                      draft.engine === 'local'
                        ? t.localNote
                        : draft.engine === 'youcom'
                          ? t.youcomNote
                          : t.cliNote,
                      'keyless',
                    ),
              canKey ? hint(t.apiKeyHint, 'api-key-rotation') : null,
              // 这些免密钥引擎完全不需要注册。这里留白会被读成「需要
              // 密钥」，而那恰恰是这些引擎唯一不需要的东西。
              // 没有密钥字段的免密钥引擎（youcom）在上面有自己的说明。
              canKey && KEYLESS_ENGINES.indexOf(draft.engine) >= 0 && !current.hasKey
                ? hint(t.keylessTier, 'keyless-tier')
                : null,
              canKey ? textField(t.baseUrl, 'baseURL', t.endpointFallback) : null,
              // 密钥来自哪里，只说明一次：保存胜不过环境变量，这里沉默
              // 会被读成保存什么也没做。
              canKey && current.keySource === 'env' ? hint(t.envNote, 'envnote') : null,
              canModel ? textField(t.model, 'model', t.modelFallback) : null,
              // 露出矩阵。两个独立勾选框会被读成两个互不相关的开关；它们
              // 其实是对形态的一次选择，所以收拢成一次选择，把四种形态
              // 逐一写明。
              fieldRow(
                t.exposeTitle,
                h(
                  'select',
                  {
                    value: draft.exposeState,
                    // 让测试能把这个下拉框与引擎偏好那个区分开；没有它，
                    // 任何关于选项的断言都会横跨两者。
                    'data-select': 'expose',
                    onChange: (event) => {
                      set('exposeState', event.target.value);
                    },
                    style: {
                      appearance: 'none',
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '13px',
                      colorScheme: darkCard ? 'dark' : 'light',
                    },
                  },
                  EXPOSE_STATES.map((state) =>
                    h('option', { key: state, value: state, 'data-select': 'expose', style: optionPaint }, t.exposeStates[state]),
                  ),
                ),
                'expose-state',
              ),
              hint(t.exposeHint, 'expose-hint'),
              // 只有成为独立工具的引擎才需要一个名字，也只有 placeholder
              // 会显示推导出来的默认值：空字段表示「用那个默认值」，不是
              // 「没有名字」。
              exposesTool
                ? textField(t.toolNameLabel, 'toolName', toolNameFor(summary, draft.engine))
                : null,
              exposesTool ? hint(t.toolNameHint, 'toolname-hint') : null,
              // 代理适用于任何发起 HTTP 调用的引擎，也就是卡片列出的
              // 全部引擎。
              textField(t.proxyLabel, 'proxy', t.proxyFallback),
              hint(t.proxyHint, 'proxy-hint'),
              fieldRow(
                h(
                  'span',
                  null,
                  t.autoTitle,
                  h(
                    'span',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        fontWeight: 400,
                        marginLeft: '8px',
                      },
                    },
                    t.autoHint,
                  ),
                ),
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '2px',
                    },
                  },
                  statusRows.length > 0
                    ? h(
                        'div',
                        {
                          key: 'engines',
                          style: { display: 'flex', flexWrap: 'wrap', gap: '10px 18px' },
                        },
                        statusRows,
                      )
                    : null,
                  chainNote
                    ? h(
                        'div',
                        {
                          key: 'note',
                          style: {
                            fontSize: '13px',
                            color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                          },
                        },
                        chainNote,
                      )
                    : null,
                ),
                'status',
                t.autoTitle,
              ),
              h(
                'div',
                {
                  key: 'footer',
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '12px 0 4px',
                  },
                },
                h(
                  'span',
                  {
                    role: 'status',
                    style: {
                      marginRight: 'auto',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    },
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
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'none',
                      color: 'var(--dsw-alias-label-secondary, inherit)',
                      opacity: dirty ? 1 : 0.4,
                    },
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
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '1px solid transparent',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'var(--dsw-alias-label-primary, currentColor)',
                      color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                      opacity: dirty ? 1 : 0.4,
                    },
                  },
                  t.save,
                ),
              ),
            );
          }
        }

        // MCP 区块：与引擎并列的独立一节。它的存在理由是「某个 MCP 服务
        // 需要走自己的代理」——不给它单独入口，用户就只能改机器全局代理，
        // 而那会连搜索引擎一起带走。
        var mcpBlock = null;
        var mcpServers = (summary && summary.mcp) || {};
        var mcpNames = Object.keys(mcpServers);
        if (mcpNames.length > 0) {
          var mcpRows = mcpNames.map((name) => {
            var server = mcpServers[name];
            var isOpen = draft.mcpTarget === name;
            return h(
              'div',
              { key: 'mcp-' + name, style: { marginBottom: '8px' } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => draftState[1](selectMcp(summary, draft, isOpen ? '' : name)),
                  style: {
                    appearance: 'none',
                    background: 'transparent',
                    border: 'none',
                    padding: '4px 0',
                    cursor: 'pointer',
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
                    width: '100%',
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'baseline',
                  },
                },
                h('span', { style: { fontWeight: 500 } }, name),
                server.isDefault
                  ? h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '(' + t.mcpDefault + ')')
                  : null,
                h(
                  'span',
                  { style: { fontSize: '12px', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' } },
                  server.enabled === false ? '· disabled' : server.url || '',
                ),
              ),
              isOpen
                ? h(
                    'div',
                    { style: { paddingLeft: '12px', marginTop: '4px' } },
                    h('label', { style: { display: 'block', fontSize: '12px', marginBottom: '2px' } }, t.mcpUrl),
                    h('input', {
                      type: 'text',
                      value: draft.mcpUrl,
                      placeholder: server.url || '',
                      onChange: (event) => draftState[1](Object.assign({}, draft, { mcpUrl: event.target.value })),
                      style: { width: '100%', boxSizing: 'border-box', marginBottom: '6px' },
                    }),
                    h('label', { style: { display: 'block', fontSize: '12px', marginBottom: '2px' } }, t.mcpProxy),
                    h('input', {
                      type: 'text',
                      value: draft.mcpProxy,
                      placeholder: t.mcpProxyHint,
                      onChange: (event) => draftState[1](Object.assign({}, draft, { mcpProxy: event.target.value })),
                      style: { width: '100%', boxSizing: 'border-box' },
                    }),
                    h(
                      'div',
                      { style: { fontSize: '12px', opacity: 0.6, marginTop: '2px' } },
                      t.mcpProxyHint,
                    ),
                    h(
                      'label',
                      { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', fontSize: '12px' } },
                      h('input', {
                        type: 'checkbox',
                        checked: draft.mcpEnabled,
                        onChange: (event) =>
                          draftState[1](Object.assign({}, draft, { mcpEnabled: event.target.checked })),
                      }),
                      t.mcpEnabled,
                    ),
                  )
                : null,
            );
          });

          mcpBlock = h(
            'div',
            { style: { marginTop: '16px' } },
            h(
              'h4',
              {
                style: { margin: '0 0 4px', fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
              },
              t.mcpSection,
            ),
            h(
              'div',
              { style: { fontSize: '12px', opacity: 0.7, marginBottom: '8px' } },
              t.mcpHint,
            ),
            mcpRows,
          );
        }

        if (view === 'page') {
          // 尺寸做成页面自带的小节标题那样，让这份表单读起来像 bundle
          // 页面又多了一节。
          return h(
            'div',
            null,
            h(
              'h4',
              {
                style: { margin: '0 0 4px', fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
              },
              t.section,
            ),
            body,
            mcpBlock,
          );
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: open
                ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
                : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
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
                    color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    fontSize: '13px',
                    lineHeight: 1.5,
                  },
                },
                t.subtitle,
              ),
            ),
            chevron(open),
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null,
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
