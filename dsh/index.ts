// DeepSeek Harness (dsh) 插件：把 harness 的 web 能力接到本包自带的 modsearch
// CLI 上。dsh 本身已经有一个 web seam（`ctx.web`），它基于可插拔的 provider
// 提供原生 `web_search` 工具，所以搜索以 provider 的身份接入，而不是再立一个
// 竞争性的工具：模型继续用稳定的 `web_search` schema，UI 继续显示引用卡片，
// 后端则换成 modsearch 的免密钥引擎链。dsh 没有 seam 覆盖的两块语料，X 和
// 聚焦式页面阅读，各自注册为独立工具；与 modlens 的 `read_image` 同理，注册
// 出去的工具 schema 每次请求都会送到模型面前，不存在「触发与否靠运气」的
// 问题。引擎从本包内的 ../dist/main.js 拉起：不走 PATH 查找，不用 npx，插件
// 与它的引擎版本锁定在一起。
//
// 通过 cordis.patch.yml 的条目加载（见 package.json 的 `dsh.bundle` manifest）：
// 一条条目挂载本插件，另一条把 `web` seam 的 `searchProvider` 指向它。引擎、
// 密钥和路由仍然保存在 ~/.searchfuse/config.json，与所有 harness 共用。
import {
  chmodSync,
  existsSync,
  statSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHidden } from './spawnHidden.js';

// 三宿主共用的子进程入口。dsh 与 Claude Code 都 spawn 它，聚合实现
// 只有 src/search.ts 一份。此处曾指向 dist/main.js（完整 CLI），但那个
// 入口还带着 commander 的参数解析与 doctor/config 等子命令，搜索并不需要。
const CLI_PATH = fileURLToPath(new URL('../dist/kernel.js', import.meta.url));
// doctor 需要完整 CLI（子命令解析、config 读取），而 CLI_PATH 指向的是
// 只认 --query 的搜索内核。两者不是同一个入口，不能共用一个常量。
const DOCTOR_CLI_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url));
// 由仓库里的一个测试与 src/schema.ts 保持同步；插件文件无法导入 TS 源码，
// 且要保持完全零依赖（只用 node 内置模块）。
const SEARCH_OUTPUT_SCHEMA = JSON.parse(
  readFileSync(new URL('./search-schema.json', import.meta.url), 'utf8'),
);
const FETCH_OUTPUT_SCHEMA = JSON.parse(
  readFileSync(new URL('./fetch-schema.json', import.meta.url), 'utf8'),
);

// CLI 的 --timeout 是按引擎计算的，而一个引擎失败后会把一份全新的预算交给
// 下一个引擎，所以每条路径还会传 --deadline：整轮运行的墙钟时间上限。单个
// 引擎分到的时间远低于 deadline，好让故障转移的引擎仍有轮次可用；而 deadline
// 又低于 harness 的预算，于是整轮运行最终总是落在结果上，或落在 CLI 那句有
// 描述性的错误上，绝不会变成宿主那边一句光秃秃的 abort。
//
// 自有工具：每引擎最多 120 秒，整轮 180 秒，外加一个越过 deadline 的协作式
// 兜底。
const OWN_TOOL_ENGINE_TIMEOUT_MS = 120_000;
const OWN_TOOL_DEADLINE_MS = 180_000;
const OWN_TOOL_BACKSTOP_MS = OWN_TOOL_DEADLINE_MS + 20_000;
// HTTP 请求的墙钟上限。服务端自己有整轮 deadline（默认 180 秒），这里比它
// 多留一点余量，免得客户端先放弃、把一个仍在正常工作的轮次掐断。
const SEARCH_TIMEOUT_MS = 240_000;
const WAKE_TIMEOUT_MS = 15_000;
// provider 路径运行在 tool-web 的预算之下（随包发布的搜索路由是 60 秒）：
// 单个引擎给 40 秒，就能在 55 秒的一整轮里给一次快速回退留出余地。
/**
 * 插件多久重新检查一次配置文件的 mtime。文件很小，stat 也很便宜；几秒钟
 * 足够短，用户刚保存完一个服务器，下一轮就期望看到它的工具。
 *
 * MCP 工具与独立引擎工具共用这一个节奏：两处盯的是同一个文件，各起一套
 * 定时器只会让两者在改动后出现短暂的看法不一致。
 */
const CONFIG_POLL_MS = 5_000;

/**
 * 有 MCP 服务端没连上时，隔多久再试一次。
 *
 * 启动时的网络抖动很常见：一个包丢了、一个服务端恰好在重启。立刻重试只会
 * 撞上同一个故障，而永远不重试则意味着那个服务端的工具一直缺席，直到用户
 * 手动改配置。30 秒足够让一次抖动过去，也短到用户不会觉得它坏了。
 */
const MCP_RETRY_DELAY_MS = 30_000;

const PROVIDER_TIMEOUT_MS = 40_000;
const PROVIDER_DEADLINE_MS = 55_000;

/**
 * 宽松的对象类型别名。
 *
 * 这个文件原本是手写 JavaScript，大量用法是「先建一个空对象，再逐键往里
 * 填」——比如 `const mcp = {}` 之后 `mcp[name] = {...}`。转成 TypeScript 后
 * `{}` 会被推断成「没有属性的空类型」，于是每个属性赋值都报错。
 *
 * 这里不逐个写精确接口，因为那是把整个文件重写一遍：这些对象大多是把配置
 * 文件的内容原样搬运、透传给宿主，形状由外部的 JSON 决定，写死在类型里
 * 只会让下一个人改配置字段时还要同步改类型。`Bag` 表达的就是这个事实：
 * 键是字符串，值是未知的，使用处自己收窄。
 */
type Bag = Record<string, any>;

/**
 * 把 catch 抓到的未知值收窄成「有 message 的错误」。
 *
 * 严格模式下 catch 的绑定推断不出 `.message`（它被推成一个空对象类型），
 * 而抛出来的东西什么形状都可能是：Error、字符串、带 code 的 Node 错误。
 * 直接读 `.message` 在类型层面被拒绝，在运行层面则对字符串抛异常得出一片空白。
 */
function caughtMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** 读取 catch 变量上的 `code`（Node 的 ENOENT 之类），没有就返回空串。 */
function caughtCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

export const name = 'modsearch';
export const inject = ['tools', 'web'];

export function apply(ctx: any, config: Bag = {}): void {
  if (config.searchProvider !== false) {
    registerSearchProvider(ctx, config);
  }
  // 两条热重载入口。它们登记在下面唯一的那套监视器上：插件自己拥有
  // ~/.searchfuse/config.json，宿主的 profile 重载信号永远不会为它触发，所以
  // 只能自己定时看一看。
  const reloaders: Array<() => void> = [];
  // MCP 服务器，在 ~/.searchfuse/config.json 的 `mcp` 下配置。协议实现作为
  // 独立的构建模块发布，因为本文件是手写的 JavaScript，无法导入 TypeScript
  // 源码。
  //
  // 所有带状态的东西都活在这个闭包里，绝不放模块作用域：在没有文件变更时，
  // 宿主会原地重载插件而不重新求值模块，于是模块级的 session 会活得比它自己
  // 的 fiber 更久，还会被下一代实例共享。
  if (config.mcp !== false) {
    reloaders.push(registerMcpTools(ctx));
  }
  // 以裸 JSON-Schema 工具定义的形式注册（不导入任何 dsh 包：developer-preview
  // 注册表接受这种定义，而 @deepseek-ai/dsh-tools 的树外解析目前还不可靠），
  // 所以本插件在 execute 内部自己负责参数校验。
  // 默认关闭：X 搜索需要有登录状态的 Grok，在没登录的机器上它只能给出降级
  // 答案。注册一个干不了自己活的工具，代价是模型每次请求都要带一份 schema，
  // 以及首次尝试时的一次失败调用。引擎本身仍保持注册，于是 `doctor` 依然能
  // 报告 Grok 是否已登录，而用户可以在它登录的那一刻立刻把这个开关打开。
  if (config.xSearch === true) {
    registerXSearchTool(ctx);
  }
  if (config.readPage !== false) {
    registerReadPageTool(ctx);
  }
  // 独立引擎工具，注册在 MCP 之前：内置名字正是 MCP 服务器不该碰的，而用户
  // 自己命名的引擎工具就属于用户。
  if (config.engineTools !== false) {
    reloaders.push(registerEngineTools(ctx));
  }
  if (reloaders.length > 0) {
    // 唯一的监视器。文件一改，两边都看一眼；各自的签名比对决定谁真的需要重建
    // 自己的工具，所以改 `mcp` 不会惊动引擎工具，反之亦然。
    watchModsearchConfigFile(ctx, () => {
      for (const reload of reloaders) {
        try {
          reload();
        } catch (error) {
          console.error(`[searchfuse] config reload failed: ${caughtMessage(error)}`);
        }
      }
    });
  }
  // 设置卡片。dsh web 用户没有终端，所以 `modsearch config set` 在那里够不着，
  // 引擎密钥也就没有入口。浏览器那一半（dsh/client.js）贡献的卡片连的是下面
  // 这条设置路由，而不是某个 settings schema，因为这些值住在
  // ~/.searchfuse/config.json，与 CLI 和其他所有 harness 共用。
  //
  // webServer 只在 web profile 下存在，而这个 cordis 没有「可选注入」的写法，
  // 所以两半都搭在带作用域的 ctx.inject 调用上：闭包只在服务存在的地方运行，
  // 服务不存在的地方它根本不运行。headless profile 则原样保留插件的工具和
  // 搜索 provider。
  if (config.settingsCard !== false && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope: any) => {
      try {
        registerConfigRoute(scope);
      } catch (error) {
        console.error(`[searchfuse] settings card route skipped: ${error}`);
      }
    });    // 从 rc.7 到 0.1.6-alpha.1，设置页是按已服务的 settings 命名空间来分发插件
    // 卡片的：只有当卡片的槽位键匹配上宿主应答过的命名空间，卡片才会被渲染。
    // 这里注册的命名空间是个空的透传，因为它的全部职责就是让卡片可被分发。
    // 值仍然留在上面那条路由背后的配置文件里。schema 按这个 seam 实际会对它
    // 调用的东西做了鸭子类型：可调用，加上 toJSON，于是本插件不需要导入任何
    // dsh 包就能描述「什么都没有」。
    //
    // 0.1.6-alpha.2 把卡片挪到了 Plugins 页，按包名索引；0.1.7 又移除了注册表：
    // 它的 settings 服务只列出 `.volatile()` 的 Config 字段，而本插件一个都没
    // 有。没有 register 的宿主在这里没什么可服务的，于是这个命名空间被静默
    // 跳过。
    ctx.inject(['settings'], (scope: any) => {
      if (typeof scope.settings.register !== 'function') {
        return;
      }
      try {
        const passThrough: Bag & { toJSON?: () => unknown } = (value: unknown) => ({
          ...((value ?? {}) as Bag),
        });
        passThrough.toJSON = () => ({
          uid: 0,
          refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
        });
        scope.settings.register('modsearch', passThrough, { base: {} });
      } catch (error) {
        console.error(`[searchfuse] settings namespace skipped: ${error}`);
      }
    });
  }
}

/**
 * web seam 的搜索能力，由 modsearch 引擎链支撑（默认 Firecrawl 免密钥、无需
 * 注册，agy 靠登录，Tavily 和 Exa 靠密钥，带冷却感知的故障转移）。`available()`
 * 必须保持廉价且离线，而 CLI 加上它的路由始终随包发布，所以这里返回 true，
 * 把真实的判定留给执行阶段：一次没有可用引擎的运行会带着逐引擎的尝试清单失败，
 * 这比在这里悄悄返回 false 要好。
 */
/**
 * 一次 `web_search` 调用的墙钟预算。
 *
 * 插件配置优先，因为不同部署可能给这个值定不同的大小。其次读配置文件的
 * `aggregate.deadlineMs`——这样用户在文件里设一个数，命令行和面向模型的工具
 * 就都用它，而不是出现两个互相打架的数。内置默认值是三者中最宽的：在 web
 * seam 之下，调用方是一个正在等模型回答的人，比终端能容忍更长的等待。
 */
function providerBudgets(config: Bag): Bag {
  const fromPlugin = {
    timeoutMs:
      typeof config?.providerTimeoutMs === 'number' && config.providerTimeoutMs > 0
        ? config.providerTimeoutMs
        : undefined,
    deadlineMs:
      typeof config?.providerDeadlineMs === 'number' && config.providerDeadlineMs > 0
        ? config.providerDeadlineMs
        : undefined,
  };
  let fromFile;
  try {
    const parsed = readModsearchConfig();
    const configured = isPlainObject(parsed.aggregate) ? parsed.aggregate.deadlineMs : undefined;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      fromFile = configured;
    }
  } catch {
    // 配置文件读不出来，并不构成让一次搜索失败的理由；下面的默认值照样能用。
  }
  const deadlineMs = fromPlugin.deadlineMs ?? fromFile ?? PROVIDER_DEADLINE_MS;
  // 单引擎预算必须给最慢的引擎在整轮预算里留出余地，所以它跟着 deadline 走，
  // 而不是变成第二个需要手动同步的数字。
  const timeoutMs = fromPlugin.timeoutMs ?? Math.min(PROVIDER_TIMEOUT_MS, deadlineMs);
  return { timeoutMs, deadlineMs };
}

function registerSearchProvider(ctx: any, config: Bag): void {
  if (typeof ctx.web?.registerSearchProvider !== 'function') {
    // developer-preview 阶段的一次接口迁移：降级成「只有工具」的插件，但要在
    // harness 日志里说出来，而不是无声消失。
    console.error('[searchfuse] web seam has no registerSearchProvider; search provider skipped');
    return;
  }
  const { timeoutMs, deadlineMs } = providerBudgets(config);
  ctx.web.registerSearchProvider({
    id: 'modsearch',
    available: () => true,
    async search(request: Bag, signal?: AbortSignal): Promise<Bag> {
      const args = [
        '-q',
        request.query,
        '--source',
        'web',
        '--timeout',
        String(timeoutMs),
        '--deadline',
        String(deadlineMs),
      ];
      if (typeof request.maxResults === 'number') {
        args.push('--max-results', String(request.maxResults));
      }
      const entry = await runCli(args, signal);
      const lines = [entry.summary];
      const uncertainty = Array.isArray(entry.uncertainty) ? entry.uncertainty : [];
      if (uncertainty.length > 0) {
        lines.push(`Uncertain: ${uncertainty.join('; ')}`);
      }
      return {
        content: lines.filter(Boolean).join('\n'),
        sources: toSources(entry.items),
        // CLI 本身已经执行了 --max-results；seam 这边无论如何都会再封一次顶。
        truncated: false,
      };
    },
  });
}

/**
 * X（Twitter）搜索：web seam 完全没有概念的那块语料。当 Grok Build 已安装且
 * 已登录时，CLI 把请求路由给它；否则由一个 web 引擎顶替，答案被标记为降级，
 * 于是「二手证据」在权威值里是显式的，绝不静默。
 */
function registerXSearchTool(ctx: any): void {
  ctx.tools.register({
    name: 'x_search',
    description:
      'Search X (Twitter) posts through the searchfuse bridge. Use for questions about posts, threads, accounts, or discussions on X: what someone posted, reactions to an event, sentiment in a community. Returns structured evidence with a summary, per-post items with URLs, and an uncertainty list. A degraded status means X itself was unreachable and a keyless web search answered second-hand. Run `npx @wenaixi/searchfuse doctor` to inspect the resolved engines.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for on X (accounts, topics, time bounds in plain words)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of result items (default 8)',
        },
      },
      required: ['query'],
    },
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render: (_args: Bag, value: Bag) => [{ type: 'text', text: renderSearchEvidence(value) }],
      // 给原生引用卡片用的持久投影；只从权威值派生，所以回放时无需重跑任何
      // 东西。
      presentationMeta: (_args: Bag, value: Bag) => ({ sources: toSources(value.items) }),
    },
    // CLI 自己会执行 deadline；这里只是协作式的兜底。
    timeoutMs: OWN_TOOL_BACKSTOP_MS,
    isConcurrencySafe: () => true,
    presentCall: (args: Bag) => ({
      card: 'generic',
      title: 'x_search',
      kind: 'search',
      rawInput: args,
    }),
    presentResult: (_args: Bag, result: Bag) => {
      if (result.isError || !result.meta || !Array.isArray(result.meta.sources)) {
        return undefined;
      }
      return { card: 'web', kind: 'search', sources: result.meta.sources, truncated: false };
    },
    async execute(args: Bag, exec: Bag) {
      if (typeof args?.query !== 'string' || args.query.trim() === '') {
        throw new Error('x_search needs a non-empty string "query".');
      }
      const cliArgs = ['-q', args.query, '--source', 'x', ...ownToolBudget()];
      if (typeof args.max_results === 'number' && args.max_results > 0) {
        cliArgs.push('--max-results', String(Math.floor(args.max_results)));
      }
      const entry = await runCli(cliArgs, exec.signal);
      // 权威值是证据加上它的来源信息；路由细节（尝试记录、耗时、引擎消耗）
      // 留在运行层，不进权威值。
      return {
        status: entry.status,
        source: entry.source,
        summary: entry.summary,
        items: Array.isArray(entry.items) ? entry.items : [],
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
      };
    },
  });
}

/**
 * 聚焦式页面阅读：抓一个 URL 并返回证据，可选地由一个问题焦点来塑形。故意做成
 * 独立工具，而不是 web seam 的 fetch provider：seam 的 fetch 契约是安全的原始
 * 抓取（真实状态码、未经消化的正文），并且按设计排除了阅读焦点；而这里是
 * LLM 处理过的阅读，带摘要、抽取后的内容、外链、不确定性清单和运行层警告。
 * CLI 默认拦截私网目标，本工具不提供任何绕过它的方式。dsh 默认也暴露它自己的
 * 原始 web_fetch，所以描述里点明了二者的分工。
 */
function registerReadPageTool(ctx: any): void {
  ctx.tools.register({
    name: 'read_page',
    description:
      'Read one web page through the searchfuse bridge and return digested evidence: a summary, the extracted content, outgoing links, uncertainty, and operational warnings such as cloud fetching. Use it over web_fetch when you want the page digested or focused on one question (pass "query"), or when the page is rendered by JavaScript and a plain fetch returns an empty shell. Use web_fetch, where available, when you need the raw page text or the HTTP status code. Private-network URLs are blocked. Page reading needs no engine setup. Run `npx @wenaixi/searchfuse doctor` to inspect the resolved route.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The http(s) URL to read',
        },
        query: {
          type: 'string',
          description:
            'Optional question to focus the reading on (e.g. "what are the rate limits")',
        },
      },
      required: ['url'],
    },
    output: {
      schema: FETCH_OUTPUT_SCHEMA,
      render: (_args: Bag, value: Bag) => [{ type: 'text', text: renderFetchEvidence(value) }],
    },
    timeoutMs: OWN_TOOL_BACKSTOP_MS,
    isConcurrencySafe: () => true,
    presentCall: (args: Bag) => ({
      card: 'generic',
      title: 'read_page',
      kind: 'fetch',
      rawInput: args,
    }),
    async execute(args: Bag, exec: Bag) {
      if (typeof args?.url !== 'string' || !/^https?:\/\//i.test(args.url.trim())) {
        throw new Error('read_page needs an http(s) "url".');
      }
      const cliArgs = ['-u', args.url, ...ownToolBudget()];
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        cliArgs.push('-q', args.query);
      }
      const entry = await runCli(cliArgs, exec.signal);
      return {
        summary: entry.summary,
        content: typeof entry.content === 'string' ? entry.content : '',
        ...(Array.isArray(entry.links) ? { links: entry.links } : {}),
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
      };
    },
  });
}

/** 给插件自有工具用的 CLI 预算参数。 */
function ownToolBudget() {
  return [
    '--timeout',
    String(OWN_TOOL_ENGINE_TIMEOUT_MS),
    '--deadline',
    String(OWN_TOOL_DEADLINE_MS),
  ];
}

/**
 * 跑一次 CLI，从它的 envelope 里取出那一条 source 记录。当运行失败、或该
 * source 返回 unavailable 时抛出异常并带上逐引擎的尝试轨迹，这样 harness 的
 * 错误信息里说的就是实际试过什么。
 */
/**
 * 被拉起的 CLI 所需的环境。Electron 会把桌面可执行文件暴露为 process.execPath，
 * 它的子进程必须进入 Node 模式，否则 CLI 的路径和参数会被交回给应用本身。
 */
function childEnv() {
  return process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
}

/**
 * 本插件拉起的 CLI。只有 npm 包才带 dist/：从 GitHub 源码安装（DSH 的添加
 * 对话框接受仓库 URL）没有构建产物，此时 Node 打印的那句光秃秃的
 * "Cannot find module" 也没指出任何出路。
 */
function cliPath() {
  const cli = process.env.MODSEARCH_DSH_CLI || CLI_PATH;
  if (!existsSync(cli)) {
    throw new Error(
      `searchfuse's CLI build is missing (${cli}). This happens when the plugin was ` +
        'installed from its GitHub repository, which ships source only. Remove the ' +
        'plugin and add it again by package name: @wenaixi/searchfuse',
    );
  }
  return cli;
}

/**
 * 读本地服务的运行时信息：`~/.searchfuse/runtime.json`。
 *
 * 返回 undefined 表示服务没起（文件不在、读不了、或不是我们要的形状）。
 * 调用方据此回退到子进程。
 */
function readServeRuntime() {
  const file = join(homedir(), '.searchfuse', 'runtime.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return undefined;
  return { port: parsed.port, token: parsed.token };
}

/**
 * 取一次搜索结果：**服务优先，子进程兜底**。
 *
 * 为什么要两条：服务在跑时省掉一次 Node 启动（约 200ms）；服务不在时
 * 用户仍然能搜。只走一条就等于把可用性押在另一件事上。
 */
/**
 * 把一份 CLI 风格的参数表翻译成服务端路由。
 *
 * 短式（`-q`/`-u`）与长式（`--query`/`--url`）都认：插件自有工具用的是短式，
 * 而 provider seam 走的是长式；按位置下标取参数则会读到 flag 本身。
 */
function toServeRequest(args: string[]): Bag | undefined {
  const flag = (...names: string[]): string | undefined => {
    for (const name of names) {
      const index = args.indexOf(name);
      if (index !== -1) return args[index + 1];
    }
    return undefined;
  };
  // 预算对搜索和读页都一样适用，所以先收好，两条路由各自带上。
  const budgets = new URLSearchParams();
  const timeout = flag('--timeout');
  if (timeout !== undefined) budgets.set('timeout', timeout);
  const deadline = flag('--deadline');
  if (deadline !== undefined) budgets.set('deadline', deadline);
  const withBudgets = (params: URLSearchParams): URLSearchParams => {
    for (const [key, value] of budgets) params.set(key, value);
    return params;
  };

  const url = flag('-u', '--url');
  if (url !== undefined) {
    return { endpoint: '/v1/read-page', params: withBudgets(new URLSearchParams({ url })) };
  }
  const query = flag('-q', '--query');
  if (query === undefined) return undefined;
  const params = withBudgets(
    new URLSearchParams({ q: query, source: flag('--source') ?? 'web' }),
  );
  const max = flag('--max-results');
  if (max !== undefined) params.set('max', max);
  return { endpoint: '/v1/search', params };
}

/** 调一次服务；拿到文本就返回，否则 undefined。 */
async function tryServe(args: string[], signal?: AbortSignal): Promise<string | undefined> {
  const runtime = readServeRuntime();
  if (runtime === undefined) return undefined;
  const request = toServeRequest(args);
  if (request === undefined) return undefined;
  // 一次聚合可能要几十秒，所以给足时间；但必须有上限，否则服务卡住时
  // 这次工具调用会永久挂起，只能靠宿主信号兜底。
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const url = `http://127.0.0.1:${runtime.port}${request.endpoint}?${request.params.toString()}`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtime.token}`, accept: 'application/json' },
      signal: combined,
    });
    const body = await response.text();
    if (response.ok) return body;
    // 服务端 5xx 的正文里带着逐引擎的尝试轨迹（例如谁没登录、谁超时）。
    // 把它原样抛出去，宿主的错误信息才说得出实际试过什么；若服务端回的是
    // 空正文或非 JSON，就交给上层按「不可达」处理。
    if (response.status >= 500 && body.trim() !== '') {
      throw new Error(describeServeFailure(response.status, body));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(SERVE_FAILURE_PREFIX)) {
      throw error;
    }
    // 连接被拒或超时：交给上层决定下一步。
  }
  return undefined;
}

/** 一句前缀，用来把「服务端的业务错误」与「连不上」区分开。 */
const SERVE_FAILURE_PREFIX = 'searchfuse service error: ';

/** 把服务端的错误正文转成宿主可读的消息。 */
function describeServeFailure(status: number | string, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    if (isPlainObject(parsed) && typeof parsed.error === 'string') {
      detail = parsed.error;
    }
  } catch {
    // 不是 JSON：正文本身就是那句话。
  }
  return `${SERVE_FAILURE_PREFIX}${status} ${detail.slice(0, 600)}`;
}

/**
 * 唤醒服务：用 `serve --ensure` 幂等地把它拉起来。
 *
 * 为什么不是 `spawn(serve)` 直接起：`--ensure` 会先探 `/healthz`，
 * 已经在跑就 exit 0，不会重复起第二个实例抢同一个文件。
 *
 * 返回是否**这次真的把它拉起来了**（供上层的重试判断）。
 */
async function wakeServe(signal?: AbortSignal): Promise<boolean> {
  // `cliPath()` 抛出的「构建缺失」是一个能直接照做的指示（重装），不能被
  // 下面的 catch 吞成一句笼统的「不可达」。
  const cli = cliPath();
  const timeout = AbortSignal.timeout(WAKE_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const { code } = await run(process.execPath, [cli, 'serve', '--ensure'], combined, childEnv());
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * 取一次搜索结果。**两级**：HTTP -> 唤醒并重试。
 *
 * 没有第三级「搜完就 spawn 一个一次性 kernel」。那条路会绕过服务，
 * 也让三宿主本来共享的缓存与冷却状态失去意义；而且它是一个并行的
 * 第二实现——同一个查询在这里有两套代码路径，出问题时很难判断
 * 到底走的哪一套。服务起不来就如实报错，把故障暴露出来，而不是
 * 悄悄退化成另一种行为。
 *
 * 唤醒本身要起一个进程（`serve --ensure`），这是服务的入口，不是
 * 兜底的重复实现。
 */
async function fetchOrSpawn(args: string[], signal?: AbortSignal): Promise<string> {
  const first = await tryServe(args, signal);
  if (first !== undefined) return first;

  const woke = await wakeServe(signal);
  if (woke) {
    const second = await tryServe(args, signal);
    if (second !== undefined) return second;
  }

  throw new Error(
    'searchfuse service is not reachable and could not be started. ' +
      'Run `npx @wenaixi/searchfuse serve --ensure` in a terminal to see why, ' +
      'then `npx @wenaixi/searchfuse doctor` to check the engine setup.',
  );
}

async function runCli(args: string[], signal?: AbortSignal): Promise<Bag> {
  const stdout = await fetchOrSpawn(args, signal);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`modsearch produced no JSON: ${stdout.trim().slice(0, 300)}`);
  }
  const entry = Array.isArray(parsed.results) ? parsed.results[0] : undefined;
  if (!entry || typeof entry.summary !== 'string') {
    throw new Error('modsearch returned an envelope without a usable source entry');
  }
  if (entry.status === 'unavailable') {
    const attempts = (Array.isArray(entry.attempts) ? entry.attempts : [])
      .map((attempt: Bag) => `${attempt.engine}: ${attempt.error ?? 'skipped'}`)
      .join('; ');
    throw new Error(
      `modsearch could not reach the requested source${attempts ? ` (${attempts})` : ''}. ` +
        'Run `npx @wenaixi/searchfuse doctor` in a terminal to check the engine setup.',
    );
  }
  return entry;
}

/** 把 CLI 的结果条目映射成 seam 的可引用来源结构，顺手丢掉垃圾项。 */
function toSources(items: unknown): Bag[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((item: Bag) => item && typeof item.url === 'string' && item.url !== '')
    .map((item: Bag) => ({
      url: item.url,
      ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
      ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
      ...(typeof item.published_at === 'string' && item.published_at !== ''
        ? { publishedAt: item.published_at }
        : {}),
    }));
}

function renderSearchEvidence(value: Bag): string {
  const lines: string[] = [];
  if (value.status === 'degraded') {
    lines.push(
      `[X was unreachable; a ${value.source} search answered second-hand. Treat as indirect evidence.]`,
    );
  }
  lines.push(value.summary);
  const items = value.items ?? [];
  if (items.length > 0) {
    lines.push('', 'Results:');
    items.forEach((item: Bag, index: number) => {
      const dated = item.published_at ? ` (${item.published_at})` : '';
      lines.push(`${index + 1}. ${item.title}${dated} — ${item.url}`);
      if (item.snippet) {
        lines.push(`   ${item.snippet}`);
      }
    });
  }
  const uncertainty = value.uncertainty ?? [];
  if (uncertainty.length > 0) {
    lines.push('', `Uncertain: ${uncertainty.join('; ')}`);
  }
  return lines.join('\n');
}

const RENDER_CONTENT_CAP = 20_000;
const RENDER_LINK_CAP = 20;

function renderFetchEvidence(value: Bag): string {
  const lines: string[] = [value.summary];
  const content = value.content?.trim();
  if (content) {
    lines.push(
      '',
      'Content:',
      content.length > RENDER_CONTENT_CAP ? `${content.slice(0, RENDER_CONTENT_CAP)}…` : content,
    );
  }
  const links = Array.isArray(value.links) ? value.links.slice(0, RENDER_LINK_CAP) : [];
  if (links.length > 0) {
    lines.push('', 'Links:');
    for (const link of links) {
      lines.push(`- ${link.text} — ${link.url}`);
    }
  }
  const uncertainty = value.uncertainty ?? [];
  if (uncertainty.length > 0) {
    lines.push('', `Uncertain: ${uncertainty.join('; ')}`);
  }
  const warnings = value.warnings ?? [];
  if (warnings.length > 0) {
    lines.push('', `Warnings: ${warnings.join('; ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 设置卡片，宿主这一半：它读写 ~/.searchfuse/config.json，也就是 CLI 编辑的
// 同一个文件，所以在浏览器里设的密钥，就是其他每个 harness 用的密钥。浏览器
// 永远收不到密钥本身，只会收到「有没有存过」。
// ---------------------------------------------------------------------------

/** 本插件自己注册的工具名。MCP 服务器不得占用其中之一：一次静默覆盖会把
 * 内置工具替换成第三方服务器随便起的名字。
 */
const BASE_TOOL_NAMES = ['x_search', 'read_page'];

/** 配置提升为独立工具的每个引擎，按它们注册时的名字。每次新鲜读取，使保存的
 * 改动在下一次加载时生效。 */
function engineToolNames() {
  try {
    const config = readModsearchConfig();
    const engines = (isPlainObject(config.engines) ? config.engines : {}) as Bag;
    return Object.entries(engines)
      .filter(
        ([, rawSettings]) => {
          const settings = rawSettings as Bag;
          return (
            isPlainObject(settings) &&
            isPlainObject(settings.expose) &&
            (settings.expose as Bag).tool === true &&
            // 与 registerEngineTools 遵循的规则相同：被关掉的引擎不是工具，所以
            // 它的名字可以被别人占用。
            coerceBoolean(settings.enabled) !== false
          );
        },
      )
      .map(([rawName, settings]) =>
        typeof settings.toolName === 'string' && settings.toolName.trim() !== ''
          ? settings.toolName.trim()
          : `${canonicalEngine(rawName)}_search`,
      );
  } catch {
    return [];
  }
}

/** 卡片提供的引擎，顺序就是文档介绍它们的顺序。 */
const CARD_ENGINES = [
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
/** 需要 API 密钥的引擎。 */
const KEYED_ENGINES = ['tavily', 'exa', 'firecrawl', 'keenable', 'anysearch'];
/**
 * 需要 `baseURL` 的引擎。SearXNG 在这里而不在需要密钥的那组：它需要一个
 * 对端主机来通信，但不需要凭证，这两种能力分开校验，所以一次卡片保存不会
 * 把 API 密钥写到跟它毫无关系的引擎上。
 */
const ENDPOINT_ENGINES = [...KEYED_ENGINES, 'searxng'];
/**
 * 一次运行真的会读取其 `model` 设置的引擎。其余引擎不显示这个字段，而不是
 * 显示一个背后什么都没有的输入框：HTTP 引擎忽略它，而 grok-cli 跟随的
 * 是 Grok Build 当前登录的账号。
 */
const MODEL_ENGINES = ['antigravity-cli'];
/**
 * 默认不激活的引擎，与 `src/config.ts` 的 `OFF_UNLESS_ENABLED` 是一份跨端
 * 副本：本文件是手写 JavaScript，不能 import TypeScript 源码。
 * `dshPlugin.test.ts` 有一条 lockstep 断言两边一致。
 *
 * 它们仍然出现在卡片上，用户可以逐个打开；而 `doctor` 照样报告它们是否存在，
 * 所以「装了吗」和「开着吗」是两个可以分开看的答案。
 */
const DEFAULT_OFF_ENGINES = ['antigravity-cli'];
/**
 * 所有被接受的拼写，与 src/config.ts 里的 CANONICAL_ENGINE 对应。用别名保存
 * 的设置就是同一个引擎的设置，所以卡片必须在它们本来所在的地方读写。
 */
const ENGINE_ALIASES = {
  antigravity: 'antigravity-cli',
  agy: 'antigravity-cli',
  grok: 'grok-cli',
  http: 'local',
  direct: 'local',
};
/**
 * 按字段覆盖文件值的环境变量，与 src/config.ts 的 ENV_BINDINGS 对应。一张
 * 只读文件的卡片，对一个通过环境变量导出密钥的容器会显示空表单，并把一个
 * 正常工作的引擎报告成未配置。
 */
const ENGINE_ENV_BINDINGS = {
  tavily: { apiKey: 'TAVILY_API_KEY', baseURL: 'TAVILY_BASE_URL' },
  exa: { apiKey: 'EXA_API_KEY', baseURL: 'EXA_BASE_URL' },
  firecrawl: { apiKey: 'FIRECRAWL_API_KEY', baseURL: 'FIRECRAWL_BASE_URL' },
  keenable: { apiKey: 'KEENABLE_API_KEY', baseURL: 'KEENABLE_BASE_URL' },
  anysearch: { apiKey: 'ANYSEARCH_API_KEY', baseURL: 'ANYSEARCH_BASE_URL' },
};

/** 一个存储名所指的规范引擎；它什么都不指时返回 ''。 */
function canonicalEngine(name: unknown): string {
  if (typeof name !== 'string') {
    return '';
  }
  const trimmed = name.trim().toLowerCase();
  if (CARD_ENGINES.includes(trimmed)) {
    return trimmed;
  }
  // 只查自有属性：裸下标会走原型链，于是 "constructor" 会以一个函数的身份
  // 返回来，并被当成一个引擎。
  return Object.hasOwn(ENGINE_ALIASES, trimmed)
    ? (ENGINE_ALIASES as Bag)[trimmed]
    : '';
}

/** 只认 JSON 对象：null、数组和原型上的成员都不算设置。 */
function isPlainObject(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 对齐 CLI 对手改布尔值的处理方式，但不迁移文件。 */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return undefined;
}

/**
 * 这个引擎此刻是开着的吗？
 *
 * 与 `src/config.ts` 的 `engineSettings()` 里那段 OFF_UNLESS_ENABLED 判定
 * 对齐：未设置 `enabled` 时，名单里的引擎算关，其余算开；显式写下的值永远
 * 压过默认。宿主半边必须自己判一遍，因为它不能 import TypeScript 源码，而
 * 判错一次就是「卡片上打开的引擎其实从来没被用过」。
 */
function engineEnabled(name: string, settings: Bag = {}): boolean {
  const explicit = coerceBoolean(settings.enabled);
  if (explicit !== undefined) {
    return explicit;
  }
  return !DEFAULT_OFF_ENGINES.includes(name);
}

/** 逗号分隔的 API 密钥值里是否至少含一个真实密钥。 */
function hasApiKeys(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value
      .split(',')
      .map((key) => key.trim())
      .some((key) => key !== '')
  );
}

/** ~/.searchfuse/config.json，每个 harness 共用的那一个文件。 */
function modsearchConfigPath() {
  // 与 src/config.ts 的 DIR_NAME 保持一致。这里曾返回 `.modsearch`，
  // 于是冲突：CLI 读写 `.searchfuse`，卡片读写 `.modsearch`，同一段注释
  // 却写着 `.searchfuse`。两个路径各存一份配置，改一边另一边看不到。
  return join(homedir(), '.searchfuse', 'config.json');
}

/**
 * 共享配置，原样读出。只有文件不存在才当作空：一个存在却解析不了的文件
 * 是某人的配置，一张把它当作空的卡片会在下次保存时覆盖掉它。
 *
 * 刻意不用 CLI 的 loadConfigFile：那个在读取时会迁移遗留结构，而一次保存
 * 并不是重写用户没要求处理的文件的时机。卡片不拥有的东西，它就不碰。
 */
function readModsearchConfig() {
  const file = modsearchConfigPath();
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (caughtCode(error) === 'ENOENT') {
      return {};
    }
    throw new Error(`cannot read ${file}: ${caughtMessage(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${caughtMessage(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${file} does not hold a JSON object`);
  }
  return parsed;
}

/** 持有某个引擎设置的文件条目键：它自己的，加上别名。 */
function fileKeysFor(engine: string, config: Bag): string[] {
  const engines = isPlainObject(config.engines) ? config.engines : {};
  return Object.keys(engines).filter((key) => canonicalEngine(key) === engine);
}

/**
 * 某个引擎的文件设置，别名条目按 CLI 的方式合并：按文件顺序，所以靠后的
 * 条目胜出，正是 migrateLegacyConfig 折叠它们的方式。
 */
function fileSettingsFor(engine: string, config: Bag): Bag {
  const engines = (isPlainObject(config.engines) ? config.engines : {}) as Bag;
  let settings: Bag = {};
  for (const key of fileKeysFor(engine, config)) {
    if (isPlainObject(engines[key])) {
      settings = { ...settings, ...engines[key] };
    }
  }
  return settings;
}

/** 某个引擎的环境设置，按字段，与 engineSettings 应用它们的方式一致。 */
function envSettingsFor(engine: string, env: NodeJS.ProcessEnv = process.env): Bag {
  const settings: Bag = {};
  const bindings = (Object.hasOwn(ENGINE_ENV_BINDINGS, engine)
    ? (ENGINE_ENV_BINDINGS as Bag)[engine]
    : {}) as Bag;
  for (const [field, variable] of Object.entries(bindings)) {
    const raw = env[variable as string];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value !== '' && (field !== 'apiKey' || hasApiKeys(value))) {
      settings[field] = value;
    }
  }
  return settings;
}

/**
 * 卡片被允许知道的内容：每个引擎的端点和模型，外加是否存过密钥以及它来自
 * 哪里，且永远不包括密钥本身。读不到秘密的浏览器泄漏不了秘密，也写不回一个
 * 空白值把它盖掉。
 */
function engineSummary(config: Bag = readModsearchConfig(), env: NodeJS.ProcessEnv = process.env): Bag {
  const engines: Bag = {};
  for (const name of CARD_ENGINES) {
    const fromFile = fileSettingsFor(name, config);
    const fromEnv = envSettingsFor(name, env);
    const fileKey = hasApiKeys(fromFile.apiKey);
    const envKey = hasApiKeys(fromEnv.apiKey);
    engines[name] = {
      baseURL: fromEnv.baseURL ?? (typeof fromFile.baseURL === 'string' ? fromFile.baseURL : ''),
      model: typeof fromFile.model === 'string' ? fromFile.model : '',
      hasKey: envKey || fileKey,
      // 生效值：「文件里写没写」与「此刻开没开」是两回事，默认关闭的引擎
      // 在文件里往往一个字都没有。卡片要的是后者。
      enabled: engineEnabled(name, fromFile),
      // 标出「关闭来自默认而不是用户亲手关的」：卡片据此说明打开它需要先存
      // 一份显式设置。
      defaultOff: DEFAULT_OFF_ENGINES.includes(name) && coerceBoolean(fromFile.enabled) === undefined,
      // 曝光矩阵以及随之而来的两个字段。只报告引擎自己的值：代理为空意味着
      // 文件里没有，这就是卡片显示的内容。
      expose: isPlainObject(fromFile.expose) ? fromFile.expose : {},
      proxy: typeof fromFile.proxy === 'string' ? fromFile.proxy : '',
      toolName: typeof fromFile.toolName === 'string' ? fromFile.toolName : '',
      // 环境变量里的密钥在运行时压过文件里的密钥，所以一张报告文件密钥的
      // 卡片，会在一次看起来什么也没改的保存之后解释错误的原因。
      keySource: envKey ? 'env' : fileKey ? 'file' : null,
    };
  }
  // MCP server：卡片要能单独给每一个配代理。默认集合（context7/grep）
  // 即使文件里没写也要列出来——用户正是要给它们配代理才需要这张表。
  const mcp: Bag = {};
  var configuredMcp = isPlainObject(config.mcp) ? config.mcp : {};
  var defaultMcp = {
    context7: { transport: 'streamable-http', url: 'https://mcp.context7.com/mcp' },
    grep: { transport: 'streamable-http', url: 'https://mcp.grep.app' },
  };
  var mcpNames = Object.keys(defaultMcp);
  for (var extra of Object.keys(configuredMcp)) {
    if (!mcpNames.includes(extra)) mcpNames.push(extra);
  }
  for (var name of mcpNames) {
    var fromFile = isPlainObject(configuredMcp[name]) ? configuredMcp[name] : {};
    var fromDefault = (defaultMcp as Bag)[name] || {};
    var enabled = fromFile.enabled !== false;
    mcp[name] = {
      url: typeof fromFile.url === 'string' && fromFile.url !== '' ? fromFile.url : fromDefault.url || '',
      transport: typeof fromFile.transport === 'string' ? fromFile.transport : 'streamable-http',
      // 三态代理：'' = 跟随环境变量，'direct' = 直连，URL = 用该代理。
      // 空串与「没配」必须区分，所以文件里的 null 报成 'direct'。
      proxy:
        fromFile.proxy === null
          ? 'direct'
          : typeof fromFile.proxy === 'string'
            ? fromFile.proxy
            : '',
      enabled,
      // 文件里没写这一项：卡片要标「默认」，并知道保存时是新建还是改已有的。
      isDefault: Object.hasOwn(configuredMcp, name) === false,
    };
  }

  return {
    // 三种状态分开：钉在某个引擎上、由它的某个别名钉住（按规范名报告），
    // 或者根本没有钉住，也就是由引擎链按可用性挑选。
    engine: canonicalEngine(config.engine),
    engines,
    keyed: KEYED_ENGINES,
    endpoints: ENDPOINT_ENGINES,
    models: MODEL_ENGINES,
    mcp,
    // 卡片要展示拖动排序与「聚合/退避」选择，所以两者都得下发。
    //
    // 顺序下发的是文件里写的那份**原始名单**，不是补齐后的完整顺序：卡片要
    // 区分「用户亲手排过的」与「从没排过的」，补全之后就看不出来了。卡片
    // 自己知道全部引擎是谁，补齐是它的事。
    engineOrder: Array.isArray(config.aggregate?.engineOrder)
      ? config.aggregate.engineOrder.filter((name: unknown) => typeof name === 'string')
      : [],
    // 未写 mode 等于融合，与 src/config.ts 的 aggregateMode() 同一判据。
    aggregateMode: config.aggregate?.mode === 'chain' ? 'chain' : 'rrf',
    // SearXNG 的抓取配置。卡片要能逐引擎配代理，所以这里原样交出去，
    // 保存时由 applyCardSettings 校验并写回。
    //
    // `embedded` 必须与 src/config.ts 的 `engineSettings()` 用同一个判据
    // （`!== false`）：文件里没写这个键就等于开启。曾经这里写的是
    // `=== true`，于是全新用户打开卡片看到「关闭」，而运行时内置实例
    // 明明可用 —— 一张撒谎的设置页比没有设置页更糟。
    searxng: {
      embedded: config.searxng?.embedded !== false,
      outgoing: isPlainObject(config.searxng?.outgoing) ? config.searxng.outgoing : {},
      networks: isPlainObject(config.searxng?.networks) ? config.searxng.networks : {},
      engines: isPlainObject(config.searxng?.engines) ? config.searxng.engines : {},
    },
  };
}

/**
 * 把一次卡片提交应用到共享文件。只有卡片的三个关注点能动：引擎偏好、被点名
 * 的那个引擎自己的密钥、端点和模型，以及自动参与。`bin`、
 * `allowPrivateNetwork`、`cooldown` 和 `keylessFetch` 只留给 CLI，其余每个
 * 键都原样抄过去。
 *
 * 缺失或空的 `apiKey` 不动已存的那一个：卡片从不收到密钥，所以它也绝不能被
 * 一个它自己显示出来的空白字段给清掉。
 */
function applyCardSettings(patch: Bag): void {
  const config = readModsearchConfig();
  if (patch?.engine !== undefined) {
    const pin = typeof patch.engine === 'string' ? patch.engine.trim() : '';
    if (pin === '') {
      // 空串是 CLI 自己表示「自动」的拼法，不是一个缺失的值。
      config.engine = '';
    } else {
      const engine = canonicalEngine(pin);
      if (!CARD_ENGINES.includes(engine)) {
        throw new Error(`unknown engine: ${patch.engine}`);
      }
      config.engine = engine;
    }
  }
  // 拖动排序写回：整份名单替换，而不是逐项追加。
  //
  // 顺序就是它本来的样子，不能用 merge 语义：把 A 拖到 B 前面，本质上是
  // 「A 和 B 的相对位置变了」，而任何只增不减的合并都表达不了这一点。
  // 名单过长的部分被截掉，重复项去重，未知引擎名直接拒绝 —— 它只可能来自
  // 一个过期的卡片，而静默丢弃会让用户看着屏幕上的顺序与文件里的不符。
  if (patch?.engineOrder !== undefined) {
    if (!Array.isArray(patch.engineOrder)) {
      throw new Error('engineOrder must be an array of engine names');
    }
    const seen = new Set<string>();
    const order: string[] = [];
    for (const raw of patch.engineOrder) {
      const engine = canonicalEngine(raw);
      if (!CARD_ENGINES.includes(engine)) {
        throw new Error(`unknown engine in engineOrder: ${String(raw)}`);
      }
      // 重复项保留第一次出现的位置，不报错：拖动实现里重复态是中间态，
      // 用户没有为此做错什么。
      if (seen.has(engine)) continue;
      seen.add(engine);
      order.push(engine);
    }
    if (order.length === 0) {
      // 空名单等于「没排过」，删键而不是写一个空数组：后者在文件里看起来
      // 像一次刻意的设置，而它其实只是用户把卡片收了起来。
      if (config.aggregate !== undefined) {
        delete config.aggregate.engineOrder;
        if (Object.keys(config.aggregate).length === 0) delete config.aggregate;
      }
    } else {
      config.aggregate = Object.assign({}, config.aggregate, { engineOrder: order });
    }
  }
  // 聚合与退避二选一。写 'chain' 或 'rrf' 都落成显式值；'rrf' 是默认，
  // 但删键与写键的读回结果相同，写显式值让文件自己说明当前行为。
  if (patch?.aggregateMode !== undefined) {
    const mode = patch.aggregateMode;
    if (mode !== 'rrf' && mode !== 'chain') {
      throw new Error(`aggregateMode must be "rrf" or "chain", got: ${String(mode)}`);
    }
    config.aggregate = Object.assign({}, config.aggregate, { mode });
  }
  // 引擎字段一次编辑一个引擎，由 `target` 点名。缺失意味着这次保存没有碰任何
  // 引擎设置，这正是「只改钉住项」的保存的样子。
  if (patch?.target !== undefined) {
    const engine = canonicalEngine(patch.target);
    if (!CARD_ENGINES.includes(engine)) {
      throw new Error(`unknown engine: ${patch.target}`);
    }
    if (!KEYED_ENGINES.includes(engine) && patch.apiKey !== undefined) {
      throw new Error(`${engine} takes no API key`);
    }
    if (!ENDPOINT_ENGINES.includes(engine) && patch.baseURL !== undefined) {
      throw new Error(`${engine} takes no base URL`);
    }
    if (!MODEL_ENGINES.includes(engine) && patch.model !== undefined) {
      throw new Error(`${engine} takes no model setting`);
    }
    if (config.engines !== undefined && !isPlainObject(config.engines)) {
      throw new Error('the "engines" section of the config file is not an object');
    }
    // 写到读取时真正生效的位置：持有该引擎设置的最后一个条目，就是合并时
    // 胜出的那个，所以用别名保存的密钥是被更新，而不是被一份 CLI 永远读不到
    // 的第二份副本遮蔽。
    const holders = fileKeysFor(engine, config);
    const target = holders.length > 0 ? holders[holders.length - 1] : engine;
    config.engines = { ...config.engines };
    if (config.engines[target] !== undefined && !isPlainObject(config.engines[target])) {
      throw new Error(`the "engines.${target}" entry of the config file is not an object`);
    }
    const settings = { ...config.engines[target] };
    if (patch.baseURL !== undefined) {
      const baseURL = typeof patch.baseURL === 'string' ? patch.baseURL.trim() : '';
      if (baseURL === '') {
        // 空串取消这个覆盖，回到官方端点。
        delete settings.baseURL;
      } else if (!/^https?:\/\//i.test(baseURL)) {
        // CLI 应用的也是同一条规则，理由也一样：这个主机会收到该引擎的 API
        // 密钥。
        throw new Error(
          `invalid base URL: ${baseURL}. Use a full http(s) URL, e.g. https://api.example.com`,
        );
      } else {
        settings.baseURL = baseURL;
      }
    }
    if (patch.model !== undefined) {
      const model = typeof patch.model === 'string' ? patch.model.trim() : '';
      if (model === '') {
        delete settings.model;
      } else {
        settings.model = model;
      }
    }
    const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
    if (apiKey !== '') {
      settings.apiKey = apiKey;
    }
    // 空白的代理字段是「别动它」，不是「清掉它」：对代理保存在文件里的引擎，
    // 卡片显示的是空字段，所以把空白当成删除，会抹掉用户从没看见过的值。要
    // 故意移除代理，用 CLI 的 `config set <engine>.proxy ""`。
    if (typeof patch.proxy === 'string' && patch.proxy.trim() !== '') {
      const proxy = patch.proxy.trim();
      if (!isValidProxyValue(proxy)) {
        throw new Error(
          `invalid proxy: ${proxy}. Use "direct", "none", or a full http(s) URL such as http://127.0.0.1:7890`,
        );
      }
      settings.proxy = proxy;
    }
    // 曝光矩阵。缺失意味着这次保存没有碰它。
    if (isPlainObject(patch.expose)) {
      const aggregate = coerceBoolean(patch.expose.aggregate);
      const tool = coerceBoolean(patch.expose.tool);
      const next: Bag = {};
      if (aggregate !== undefined) {
        next.aggregate = aggregate;
      }
      if (tool !== undefined) {
        next.tool = tool;
      }
      if (Object.keys(next).length > 0) {
        settings.expose = { ...(isPlainObject(settings.expose) ? settings.expose : {}), ...next };
      }
    }
    if (typeof patch.toolName === 'string' && patch.toolName.trim() !== '') {
      const name = patch.toolName.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        throw new Error(
          `invalid tool name: ${name}. Use 1-64 characters of A-Z, a-z, 0-9, _ or -`,
        );
      }
      if (BASE_TOOL_NAMES.includes(name)) {
        throw new Error(`tool name "${name}" belongs to a built-in tool`);
      }
      settings.toolName = name;
    }
    config.engines[target] = settings;
  }
  // 自动路由授权。缺失意味着这次保存没有碰引擎链。`true` 移除覆盖项，因为
  // 启用是内置默认值。文件中只需要存在「退出」这一种状态。
  if (isPlainObject(patch?.enabled)) {
    if (config.engines !== undefined && !isPlainObject(config.engines)) {
      throw new Error('the "engines" section of the config file is not an object');
    }
    config.engines = { ...config.engines };
    for (const engine of CARD_ENGINES) {
      const enabled = patch.enabled[engine];
      if (typeof enabled !== 'boolean') {
        continue;
      }
      const holders = fileKeysFor(engine, config);
      if (enabled) {
        // 移除每一个别名上的覆盖。只删最后一个，可能暴露出更早的
        // `enabled: false`，而合并后的配置会把它读进去。
        for (const holder of holders) {
          if (!isPlainObject(config.engines[holder])) {
            throw new Error(`the "engines.${holder}" entry of the config file is not an object`);
          }
          const settings = { ...config.engines[holder] };
          delete settings.enabled;
          if (Object.keys(settings).length === 0) {
            delete config.engines[holder];
          } else {
            config.engines[holder] = settings;
          }
        }
        continue;
      }
      const target = holders.length > 0 ? holders[holders.length - 1] : engine;
      if (config.engines[target] !== undefined && !isPlainObject(config.engines[target])) {
        throw new Error(`the "engines.${target}" entry of the config file is not an object`);
      }
      config.engines[target] = { ...config.engines[target], enabled: false };
    }
  }

  // MCP server 的编辑：一个 patch 只碰一个 server，由 `mcpTarget` 点名。
  // 与引擎一样，缺失意味着这次保存没碰 MCP。
  if (patch?.mcpTarget !== undefined) {
    var mcpName = typeof patch.mcpTarget === 'string' ? patch.mcpTarget.trim() : '';
    if (mcpName === '') {
      throw new Error('mcpTarget must be a non-empty server name');
    }
    // server 名会成为工具名的一部分，合法字符集与 MCP 配置层一致。
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(mcpName)) {
      throw new Error(`invalid MCP server name: ${mcpName} (use A-Za-z0-9_- up to 32)`);
    }
    if (config.mcp !== undefined && !isPlainObject(config.mcp)) {
      throw new Error('the "mcp" section of the config file is not an object');
    }
    const existing = isPlainObject(config.mcp) && isPlainObject(config.mcp[mcpName]) ? config.mcp[mcpName] : {};

    var next = { ...existing };

    if (patch.mcpUrl !== undefined) {
      var url = typeof patch.mcpUrl === 'string' ? patch.mcpUrl.trim() : '';
      if (url !== '') {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`invalid MCP url: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`invalid MCP url: ${url} (use http or https)`);
        }
      }
      if (url === '') {
        // 空串：如果这是默认项且原本没有文件条目，就不必写一个空 url。
        Reflect.deleteProperty(next, 'url');
      } else {
        next.url = url;
      }
    }

    if (patch.mcpTransport !== undefined) {
      var transport = typeof patch.mcpTransport === 'string' ? patch.mcpTransport.trim() : '';
      if (transport !== '' && transport !== 'streamable-http') {
        throw new Error(`unsupported MCP transport: ${transport} (only streamable-http)`);
      }
      if (transport === '') Reflect.deleteProperty(next, 'transport');
      else next.transport = transport;
    }

    // 代理三态。这里是「文件里存什么」的决定点：
    //   ''       → 删掉 proxy（跟随环境变量）
    //   'direct' → 存 null（显式直连）
    //   其它     → 必须是合法 http(s) URL
    if (patch.mcpProxy !== undefined) {
      var rawProxy = typeof patch.mcpProxy === 'string' ? patch.mcpProxy.trim() : '';
      if (rawProxy === '') {
        Reflect.deleteProperty(next, 'proxy');
      } else if (rawProxy === 'direct' || rawProxy === 'none') {
        next.proxy = null;
      } else {
        let parsedProxy;
        try {
          parsedProxy = new URL(rawProxy);
        } catch {
          throw new Error(`invalid MCP proxy: ${rawProxy}`);
        }
        if (parsedProxy.protocol !== 'http:' && parsedProxy.protocol !== 'https:') {
          throw new Error(`invalid MCP proxy: ${rawProxy} (use http or https)`);
        }
        next.proxy = rawProxy;
      }
    }

    if (patch.mcpEnabled !== undefined) {
      next.enabled = patch.mcpEnabled !== false;
    }

    config.mcp = { ...(isPlainObject(config.mcp) ? config.mcp : {}), [mcpName]: next };
  }

  // SearXNG 抓取配置。三种编辑互斥，用各自的键点名：
  //   searxngEmbedded         —— 打开/关闭随包实例
  //   searxngOutgoingProxies  —— 整段 outgoing.proxies（SearXNG 内部的默认轮询）
  //   searxngNetwork          —— 一个命名网络的整段定义
  //   searxngEngine           —— 一个上游引擎的规则
  // 缺省意味着这次保存没碰它，与其余 patch 的语义一致。
  if (patch?.searxngEmbedded !== undefined) {
    if (config.searxng !== undefined && !isPlainObject(config.searxng)) {
      throw new Error('the "searxng" section of the config file is not an object');
    }
    var searxngBase = { ...(isPlainObject(config.searxng) ? config.searxng : {}) };
    // 两个布尔值都写显式值，不删键。
    //
    // src/config.ts 把「没有 embedded 键」读作开启，而旧实现遇到 `false`
    // 时删掉了这个键，于是「关闭」在写盘后等价于「开启」—— 按钮点得动、
    // 文件也变了、行为却没变。删键与写 false 只有在默认值相反时才有分，
    // 这里默认是开，所以 false 必须落成字面 false。
    if (patch.searxngEmbedded === true) {
      searxngBase.embedded = true;
    } else {
      searxngBase.embedded = false;
    }
    config.searxng = searxngBase;
  }

  // 外部实例地址与代理。空串表示清掉（回到官方端点 / 跟随环境）。
  // 它与 searxngEmbedded 共同表达「用哪一个实例」：地址非空则外部优先，
  // 否则看随包开关。
  if (patch?.searxngExternalURL !== undefined) {
    if (config.engines !== undefined && !isPlainObject(config.engines)) {
      throw new Error('the "engines" section of the config file is not an object');
    }
    config.engines = { ...(isPlainObject(config.engines) ? config.engines : {}) };
    var searxngEngineEntry =
      isPlainObject(config.engines.searxng) ? { ...config.engines.searxng } : {};
    var externalURL = typeof patch.searxngExternalURL === 'string'
      ? patch.searxngExternalURL.trim()
      : '';
    if (externalURL === '') {
      delete searxngEngineEntry.baseURL;
    } else {
      if (!/^https?:\/\//i.test(externalURL)) {
        throw new Error(`invalid SearXNG base URL: ${externalURL}. Use a full http(s) URL`);
      }
      searxngEngineEntry.baseURL = externalURL;
    }
    if (patch.searxngExternalProxy !== undefined) {
      var externalProxy = typeof patch.searxngExternalProxy === 'string'
        ? patch.searxngExternalProxy.trim()
        : '';
      if (externalProxy === '') {
        delete searxngEngineEntry.proxy;
      } else {
        if (!isValidProxyValue(externalProxy)) {
          throw new Error(`invalid SearXNG proxy: ${externalProxy}`);
        }
        searxngEngineEntry.proxy = externalProxy;
      }
    }
    config.engines.searxng = searxngEngineEntry;
  }

  // 批量上游引擎规则：{ <engineName>: { enabled?: bool, proxy?: string } }。
  //
  // 每条都先复制现有规则再逐字段覆盖，所以 UI 没暴露的 network /
  // using_tor_proxy 不会被一次保存擦掉。这也是「卡片不展示的字段必须
  // 原样保留」这条红线的落点。
  if (patch?.searxngRules !== undefined) {
    if (!isPlainObject(patch.searxngRules)) {
      throw new Error('searxngRules must be an object of engine rules');
    }
    if (config.searxng !== undefined && !isPlainObject(config.searxng)) {
      throw new Error('the "searxng" section of the config file is not an object');
    }
    var rulesBase = { ...(isPlainObject(config.searxng) ? config.searxng : {}) };
    var rulesEngines = isPlainObject(rulesBase.engines) ? { ...rulesBase.engines } : {};
    for (var [ruleKey, ruleValue] of Object.entries(patch.searxngRules)) {
      if (!isPlainObject(ruleValue)) {
        throw new Error(`searxngRules.${ruleKey} must be an object`);
      }
      var existing: Bag = isPlainObject(rulesEngines[ruleKey]) ? { ...(rulesEngines[ruleKey] as Bag) } : {};
      const rule = ruleValue as Bag;
      if (rule.enabled !== undefined) {
        if (rule.enabled === true) {
          // 「启用」是默认态，删掉 disabled 而不是写 false——与既有写法一致。
          delete existing.disabled;
        } else {
          existing.disabled = true;
        }
      }
      if (rule.proxy !== undefined) {
        var proxyLines = proxiesFromPatch(rule.proxy, `searxngRules.${ruleKey}.proxy`);
        if (Object.keys(proxyLines).length === 0) {
          delete existing.proxies;
        } else {
          existing.proxies = proxyLines;
        }
      }
      if (Object.keys(existing).length > 0) {
        rulesEngines[ruleKey] = existing;
      } else {
        delete rulesEngines[ruleKey];
      }
    }
    if (Object.keys(rulesEngines).length === 0) {
      delete rulesBase.engines;
    } else {
      rulesBase.engines = rulesEngines;
    }
    config.searxng = rulesBase;
  }

  if (patch?.searxngOutgoingProxies !== undefined) {
    if (config.searxng !== undefined && !isPlainObject(config.searxng)) {
      throw new Error('the "searxng" section of the config file is not an object');
    }
    var outgoingSection = parseProxiesPatch(patch.searxngOutgoingProxies, 'searxng.outgoing.protocols');
    var outgoingBase = { ...(isPlainObject(config.searxng) ? config.searxng : {}) };
    if (Object.keys(outgoingSection).length === 0) {
      delete outgoingBase.outgoing;
    } else {
      outgoingBase.outgoing = outgoingSection;
    }
    config.searxng = outgoingBase;
  }

  if (patch?.searxngExtraProxyTimeout !== undefined) {
    if (config.searxng !== undefined && !isPlainObject(config.searxng)) {
      throw new Error('the "searxng" section of the config file is not an object');
    }
    var extraBase = { ...(isPlainObject(config.searxng) ? config.searxng : {}) };
    var rawExtra = patch.searxngExtraProxyTimeout;
    if (rawExtra === null || rawExtra === '') {
      delete extraBase.extra_proxy_timeout;
    } else {
      var extraSeconds = typeof rawExtra === 'number' ? rawExtra : Number(rawExtra);
      if (!Number.isFinite(extraSeconds) || extraSeconds <= 0) {
        throw new Error(
          `invalid searxng.extra_proxy_timeout: ${String(rawExtra)} (use a positive number of seconds)`,
        );
      }
      extraBase.extra_proxy_timeout = extraSeconds;
    }
    config.searxng = extraBase;
  }

  if (patch?.searxngNetwork !== undefined) {
    var networkName = typeof patch.searxngNetwork === 'string' ? patch.searxngNetwork.trim() : '';
    if (networkName === '') {
      throw new Error('searxngNetwork must be a non-empty network name');
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(networkName)) {
      throw new Error(`invalid network name: ${networkName} (use A-Za-z0-9_- up to 64)`);
    }
    if (config.searxng !== undefined && !isPlainObject(config.searxng)) {
      throw new Error('the "searxng" section of the config file is not an object');
    }
    var networkBase = { ...(isPlainObject(config.searxng) ? config.searxng : {}) };
    var networks = isPlainObject(networkBase.networks) ? { ...networkBase.networks } : {};
    // null 表示删掉这条网络；删除一个被引擎引用的网络会在校验时暴露出来。
    if (patch.searxngNetworkProxies === null) {
      delete networks[networkName];
    } else if (patch.searxngNetworkProxies !== undefined) {
      var networkProxies = parseProxiesPatch(
        patch.searxngNetworkProxies,
        `searxng.networks.${networkName}.protocols`,
      );
      var existingNetwork = isPlainObject(networks[networkName]) ? networks[networkName] : {};
      var nextNetwork = { ...existingNetwork };
      if (Object.keys(networkProxies).length === 0) delete nextNetwork.proxies;
      else nextNetwork.proxies = networkProxies;
      networks[networkName] = nextNetwork;
    }
    if (Object.keys(networks).length === 0) delete networkBase.networks;
    else networkBase.networks = networks;
    config.searxng = networkBase;
  }

  if (patch?.searxngEngine !== undefined) {
    var upstreamName = typeof patch.searxngEngine === 'string' ? patch.searxngEngine.trim() : '';
    if (upstreamName === '') {
      throw new Error('searxngEngine must be a non-empty engine name');
    }
    if (config.searxng !== undefined && !isPlainObject(config.searxng)) {
      throw new Error('the "searxng" section of the config file is not an object');
    }
    var engineBase = { ...(isPlainObject(config.searxng) ? config.searxng : {}) };
    var upstreamEngines = isPlainObject(engineBase.engines) ? { ...engineBase.engines } : {};
    if (patch.searxngEngineRemove === true) {
      delete upstreamEngines[upstreamName];
    } else {
      var existingRule = isPlainObject(upstreamEngines[upstreamName])
        ? upstreamEngines[upstreamName]
        : {};
      var nextRule = { ...existingRule };
      if (patch.searxngEngineNetwork !== undefined) {
        var networkRef = typeof patch.searxngEngineNetwork === 'string'
          ? patch.searxngEngineNetwork.trim()
          : '';
        if (networkRef === '') delete nextRule.network;
        else nextRule.network = networkRef;
      }
      if (patch.searxngEngineProxies !== undefined) {
        var ruleProxies = parseProxiesPatch(
          patch.searxngEngineProxies,
          `searxng.engines.${upstreamName}.protocols`,
        );
        if (Object.keys(ruleProxies).length === 0) delete nextRule.proxies;
        else nextRule.proxies = ruleProxies;
      }
      if (patch.searxngEngineTor !== undefined) {
        if (patch.searxngEngineTor) nextRule.using_tor_proxy = true;
        else delete nextRule.using_tor_proxy;
      }
      if (patch.searxngEngineDisabled !== undefined) {
        if (patch.searxngEngineDisabled) nextRule.disabled = true;
        else delete nextRule.disabled;
      }
      upstreamEngines[upstreamName] = nextRule;
    }
    if (Object.keys(upstreamEngines).length === 0) delete engineBase.engines;
    else engineBase.engines = upstreamEngines;
    config.searxng = engineBase;
  }

  // 保存前把 searxng 段整体校验一遍：引擎引用一个不存在的网络，或者代理写错了
  // 协议，在实例启动时才报错会让「保存成功」变成一句谎话。
  const searxngError = validateSearxngSection(config.searxng);
  if (searxngError !== null) {
    throw new Error(searxngError);
  }

  writeConfigFile(config);
}

/**
 * 按 src/config.ts 写配置的方式写回：在同目录下新建一个 0600 权限的文件，再
 * 改名就位。writeFileSync 的 mode 只在它「创建」文件时生效，所以重写一个已存在
 * 的 0644 配置，会让新密钥以全局可读的权限落地，直到 chmod 才收紧。
 */
function writeConfigFile(config: Bag): void {
  const file = modsearchConfigPath();
  // 这里的符号链接会穿透到它指向的任何地方去写，所以直接拒绝而不是跟随：
  // CLI 写的是真实文件，别的形态都是这张卡片不该默默接受的安排。
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`${file} is a symlink; edit the file it points at instead`);
    }
  } catch (error) {
    if (caughtCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = join(dir, `.config.${unique}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 改名失败才是值得报告的那个错误
    }
    throw error;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // 在没有 POSIX 权限位的平台上尽力而为
  }
}

/**
 * 卡片自动模式区背后那份只读的就绪清单：这台机器上哪些引擎已经配好了。
 * `doctor --json` 不需要网络也没有配额，就能回答这个问题，所以这条路由拉起
 * 本包自带的 CLI，并从它的 roles 里取出逐引擎的判定。结果短暂缓存，因为一次
 * 探测要付出启动一个进程的代价，而重新展开卡片不该再付一遍；缓存以 CLI 路径
 * 为键，所以不同的二进制就是不同的答案。
 */
const READINESS_TTL_MS = 60_000;
const READINESS_TIMEOUT_MS = 20_000;
/** 搜索角色优先：卡片讲的是搜索，而且这也是被配置的那个角色。 */
const READINESS_ROLES = ['search', 'social', 'fetch'];
let readinessCache: { cli: string; at: number; value: Bag } | null = null;

async function engineReadiness() {
  const cli = process.env.MODSEARCH_DSH_CLI || DOCTOR_CLI_PATH;
  if (readinessCache !== null && readinessCache.cli === cli) {
    if (Date.now() - readinessCache.at < READINESS_TTL_MS) {
      return readinessCache.value;
    }
  }
  try {
    // 有界且可中止：卡住的探测会把卡片的展开也卡住，而卡片没有这一区照样
    // 能活。
    const { stdout, code } = await run(
      process.execPath,
      [cli, 'doctor', '--json'],
      AbortSignal.timeout(READINESS_TIMEOUT_MS),
      childEnv(),
    );
    if (code !== 0) {
      return null;
    }
    const roles = JSON.parse(stdout)?.roles;
    if (!Array.isArray(roles)) {
      return null;
    }
    const found = new Map();
    const ordered = [...roles].sort(
      (a, b) => READINESS_ROLES.indexOf(a?.role) - READINESS_ROLES.indexOf(b?.role),
    );
    for (const role of ordered) {
      for (const candidate of Array.isArray(role?.candidates) ? role.candidates : []) {
        const engine = canonicalEngine(candidate?.engine);
        // 一个引擎只按它自己的角色判定一次：firecrawl 在 search 和 fetch 两个
        // 角色下服务、判定还不同，而卡片讲的是搜索。
        if (!CARD_ENGINES.includes(engine) || found.has(engine)) {
          continue;
        }
        found.set(engine, {
          engine,
          role: typeof role.role === 'string' ? role.role : '',
          ready: candidate.ready === true,
          reason: typeof candidate.reason === 'string' ? candidate.reason : '',
          keySource: candidate.keySource ?? null,
        });
      }
    }
    const value = CARD_ENGINES.filter((name) => found.has(name)).map((name) => found.get(name));
    readinessCache = { cli, at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

/**
 * GET /searchfuse/config：上面那份摘要。POST：一次卡片提交。部署层的鉴权必须
 * 覆盖这条路由。裸的 webServer 注册表不继承 dsh 的 Connection 鉴权，而本插件
 * 自己也不施加任何 Host、Origin 或 Fetch Metadata 策略。
 *
 * 注册表会返回一个 disposer，但不把它绑定到任何人的生命周期上，而服务器的
 * 寿命比本插件长：Plugins 页面会不重启地关掉再打开一个 bundle。用 effect 持有
 * 它，路由就随插件一起走。放任不管的话，它会继续为一个已经关闭的插件提供配置
 * 文件，还让下一次打开变成重复注册。
 */
/**
 * 与 CLI 应用于 `engines.<name>.proxy` 的三值规则相同。这里重复实现而不是
 * 导入，因为本文件是手写的 JavaScript，够不到 TypeScript 源码；覆盖引擎清单
 * 的那个同步测试，就是让它们保持一致的样板。
 */
/**
 * 校验整段 `searxng`，返回第一条错误或 null。
 *
 * 这是 src/providers/searxngSettings.ts 里 validateSearxngConfig 的宿主侧
 * 对应实现：插件文件不能 import TypeScript 源码，所以规则在这里复写一遍，
 * 由 src/dshPlugin.test.ts 的锁步测试保证两边的错误消息与判定一致。
 */
function validateSearxngSection(section: unknown): string | null {
  if (!isPlainObject(section)) return null;
  const outgoingError = validateProxiesShape(section.outgoing, 'searxng.outgoing');
  if (outgoingError !== null) return outgoingError;

  const networks = (isPlainObject(section.networks) ? section.networks : {}) as Bag;
  for (const [name, rawNetwork] of Object.entries(networks)) {
    if (name.trim() === '') return 'searxng.networks: a network name is empty';
    const network = rawNetwork as Bag | undefined;
    const error = validateProxiesShape(network?.proxies, `searxng.networks.${name}.proxies`);
    if (error !== null) return error;
  }

  // extra_proxy_timeout 属于 outgoing 整体：SearXNG 的 Network.__init__
  // 不接受这个名字，写在某条网络下会让实例启动直接失败。
  const extra = section.extra_proxy_timeout;
  if (extra !== undefined) {
    if (typeof extra !== 'number' || !Number.isFinite(extra) || extra <= 0) {
      return 'searxng.extra_proxy_timeout must be a positive number';
    }
  }

  const upstream = (isPlainObject(section.engines) ? section.engines : {}) as Bag;
  for (const [name, rawRule] of Object.entries(upstream)) {
    if (name.trim() === '') return 'searxng.engines: an engine name is empty';
    const rule = rawRule as Bag | undefined;
    if (rule?.network !== undefined && !Object.hasOwn(networks, String(rule.network))) {
      const known = Object.keys(networks);
      return `searxng.engines.${name}.network "${String(rule.network)}" is not defined in searxng.networks (known: ${
        known.length > 0 ? known.join(', ') : 'none'
      })`;
    }
    const error = validateProxiesShape(rule?.proxies, `searxng.engines.${name}.proxies`);
    if (error !== null) return error;
  }
  return null;
}

/** 校验一个已经写进文件的 `proxies` 形状。 */
function validateProxiesShape(proxies: unknown, where: string): string | null {
  if (proxies === undefined) return null;
  if (!isPlainObject(proxies)) return `${where}: must be an object of protocols`;
  for (const key of Object.keys(proxies)) {
    if (key !== 'http' && key !== 'https' && key !== 'all://') {
      return `${where}: unknown proxies key "${key}"; use http, https, or all://`;
    }
  }
  for (const [key, raw] of Object.entries(proxies)) {
    if (raw === undefined) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const proxy of list) {
      if (typeof proxy !== 'string') return `${where}.${key}: proxy must be a string`;
      try {
        const parsed = new URL(proxy);
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
          return `${where}.${key}: invalid proxy "${proxy}"`;
        }
        if (parsed.hostname === '') return `${where}.${key}: invalid proxy "${proxy}"`;
      } catch {
        return `${where}.${key}: invalid proxy "${proxy}"`;
      }
    }
  }
  return null;
}

/**
 * 把「一行一个代理」的文本转成 proxies 结构。
 *
 * 卡片用文本框承载逐引擎代理（一行一个），这里负责把它规范成
 * `{ 'all://': [...] }`。空文本 = 清掉该引擎的代理覆盖。
 *
 * 校验与 `parseProxiesPatch` 同源：协议只认 http(s)/socks5(h)，
 * 缺 scheme 或主机都当场报错，而不是等实例启动时才炸。
 */
function proxiesFromPatch(text: unknown, where: string): Bag {
  var raw = typeof text === 'string' ? text : '';
  var lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return {};
  var parsed = [];
  for (var line of lines) {
    var url;
    try {
      url = new URL(line);
    } catch {
      throw new Error(
        `${where}: invalid proxy "${line}". Include a scheme, e.g. http://127.0.0.1:7890`,
      );
    }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
      throw new Error(
        `${where}: unsupported scheme "${url.protocol.replace(':', '')}" in "${line}"`,
      );
    }
    if (url.hostname === '') {
      throw new Error(`${where}: invalid proxy "${line}": missing host`);
    }
    parsed.push(line);
  }
  return { 'all://': parsed.length === 1 ? parsed[0] : parsed };
}

/**
 * 把卡片提交的一份 `{ http, https, all:// }` 规范成 SearXNG 认的代理表。
 *
 * 规则与 src/providers/searxngSettings.ts 的 validateProxies 完全一致：
 * 键只有三种，值可以是单个 URL 或 URL 数组，每个 URL 自带 http(s)/socks5(h)
 * 协议。两套规则必须同源，否则卡片能保存出一份实例读不进去的配置。
 *
 * `''` 或空对象表示「这一协议不要代理」；返回对象里不出现该键，渲染时也就
 * 不会写出去。
 */
function parseProxiesPatch(raw: unknown, where: string): Bag {
  if (!isPlainObject(raw)) {
    throw new Error(`${where} must be an object like { "all://": "http://127.0.0.1:7890" }`);
  }
  const allowed = ['http', 'https', 'all://'];
  const result: Bag = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (rawValue === undefined || rawValue === null) continue;
    if (!allowed.includes(rawKey)) {
      throw new Error(`${where}: unknown protocols key "${rawKey}"; use http, https, or all://`);
    }
    // 数组表示同一协议下轮询使用；单个字符串是它的简写。
    const list = Array.isArray(rawValue) ? rawValue : [rawValue];
    const proxies: string[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string') {
        throw new Error(`${where}.${rawKey}: proxy must be a string`);
      }
      const trimmed = entry.trim();
      if (trimmed === '') continue;
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error(
          `invalid proxy "${trimmed}": include a scheme, e.g. http://127.0.0.1:7890`,
        );
      }
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
        throw new Error(
          `invalid proxy "${trimmed}": unsupported scheme "${parsed.protocol.replace(':', '')}"; ` +
            'use http, https, socks5, or socks5h',
        );
      }
      if (parsed.hostname === '') {
        throw new Error(`invalid proxy "${trimmed}": missing host`);
      }
      proxies.push(trimmed);
    }
    // 单值写成字符串，多值写成数组：与 SearXNG 的 settings.yml 写法一一对应，
    // 用户把卡片里看到的内容抄进文件时不用改形状。
    if (proxies.length === 1) result[rawKey] = proxies[0];
    else if (proxies.length > 1) result[rawKey] = proxies;
  }
  return result;
}

function isValidProxyValue(value: string): boolean {
  if (value === 'direct' || value === 'none') {
    return true;
  }
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * 盯着配置文件，发现改动就回调。
 *
 * 宿主的 profile 重载信号永远不会为这份文件触发——它是插件自己的，不在
 * profile 里。每隔几秒 stat 一次是最便宜的发现办法；文件很小，代价可以忽略。
 *
 * 定时器用 unref 放掉，免得它自己把进程撑住；拆除登记在 ctx 上，所以插件
 * 卸载时不会留下一个还在跑的定时器。回调抛出的东西由调用方自己接住：这个
 * 助手只负责发现改动，不替调用方决定失败该怎么办。
 *
 * @returns 停止监视的函数。正常路径用不到它——ctx 卸载时会自己停掉。
 */
function watchModsearchConfigFile(ctx: any, onChange: () => void): () => void {
  const file = modsearchConfigPath();
  let lastMtime: number | undefined;
  try {
    lastMtime = statSync(file).mtimeMs;
  } catch {
    // 还没有配置文件：把它当成「什么都没有」，第一次创建就是一次改动。
    lastMtime = undefined;
  }
  const pollTimer = setInterval(() => {
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      // 文件被删掉也是一次值得理会的改动。
      mtime = undefined;
    }
    if (mtime === lastMtime) {
      return;
    }
    lastMtime = mtime;
    onChange();
  }, CONFIG_POLL_MS);
  if (typeof pollTimer?.unref === 'function') {
    pollTimer.unref();
  }
  const stop = () => {
    clearInterval(pollTimer);
  };
  try {
    ctx.effect(() => () => stop(), 'modsearch: config watch');
  } catch {
    // 一个已经失效的 ctx 没有 fiber 可以挂拆除；定时器会活到进程结束，
    // 这正是宿主对一个从不卸载的插件的处理方式。
  }
  return stop;
}

/**
 * 绑定配置文件 `mcp` 下点名的 MCP 服务器。
 *
 * 两条性质要紧：
 *
 * - 一个服务器连不上，绝不能拖住插件。搜索是产品；MCP 是附加项。每次失败
 *   变一行日志，其余服务器照常注册。
 * - session 活得比本次调用更久（已注册的工具要用它们），所以它们的拆除登记
 *   在 fiber 上。卸载插件会关掉它们。
 *
 * 注册是异步的，而 `apply` 是同步的。工作启动后，等它落定工具才出现；在一台
 * 服务器慢或不可达的机器上，搜索立刻可用，而不是等一个来回之后才可用。
 */
function registerMcpTools(ctx: any): () => void {
  let result: Bag | undefined;
  let disposed = false;
  let lastSignature = '';
  let inFlight = false;
  /** 失败后的自动重试定时器；null 表示没有排队的重试。 */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 配置里决定「哪些工具存在」的那一部分。 */
  const signatureOf = (servers: Bag) => {
    const shape = Object.entries(servers)
      .filter(([, server]) => isPlainObject(server))
      .map(([key, rawServer]) => {
        const server = rawServer as Bag;
        return [
          key,
          server.enabled !== false,
          Array.isArray(server.allowTools) ? [...(server.allowTools as unknown[])].sort() : null,
          isPlainObject(server.toolNames) ? Object.entries(server.toolNames as Bag).sort() : null,
          typeof server.url === 'string' ? server.url : null,
        ];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify(shape);
  };

  const settle = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    let config: Bag;
    try {
      config = readModsearchConfig();
    } catch (error) {
      console.error(`[searchfuse] mcp skipped: ${caughtMessage(error)}`);
      inFlight = false;
      return;
    }
    const servers = (isPlainObject(config.mcp) ? config.mcp : {}) as Bag;
    const enabled = Object.entries(servers).filter(
      ([, rawServer]) => isPlainObject(rawServer) && (rawServer as Bag).enabled !== false,
    );
    const signature = signatureOf(servers);
    // 自上一趟以来没有任何变化：已注册的工具正是对这一份配置的应答，替换它们
    // 只会毫无理由地把活着的工具定义删掉再重建。
    if (signature === lastSignature && result !== undefined) {
      inFlight = false;
      return;
    }

    // 旧的一代先走。旧工具仍被占用时注册新工具，会在同名上冲突，让整趟注册
    // 失败。
    if (result !== undefined) {
      result.disposeTools();
      await result.closeAll().catch(() => undefined);
      result = undefined;
    }
    lastSignature = signature;

    if (enabled.length === 0) {
      inFlight = false;
      return;
    }
    // 注册表自己产出它要的东西；宿主接受裸 JSON-Schema 定义，所以本插件仍然
    // 不导入任何 @deepseek-ai 包。
    let mod: Bag;
    try {
      // 这是构建产物，随包发布而不在本仓库的编译范围里；它没有 .d.ts，
      // 官方文档也没有承诺导出形状，所以这里显式忽略缺失的声明。
      // @ts-expect-error -- 生成的 JS 模块没有类型声明
      mod = await import('../dist/mcp-registry.js');
    } catch (error) {
      console.error(`[searchfuse] mcp client unavailable: ${caughtMessage(error)}`);
      inFlight = false;
      return;
    }
    if (disposed) {
      inFlight = false;
      return;
    }
    try {
      const registered: Bag = await mod.registerMcpServers(ctx, {
        servers: Object.fromEntries(enabled),
        allowTools: collectMcpAllowLists(servers),
        toolNames: collectMcpToolNames(servers),
        // 既有内置工具，也有用户提升为工具的任何引擎：这些名字已经在屏幕上
        // 了，一个服务器悄悄占用其中一个，等于把一个能用的工具换成别人的。
        reservedNames: [...BASE_TOOL_NAMES, ...engineToolNames()],
      });
      result = registered;
    } catch (error) {
      console.error(`[searchfuse] mcp registration failed: ${caughtMessage(error)}`);
      inFlight = false;
      return;
    }
    inFlight = false;
    // 从这一行起，`result` 就是这一代注册的会话；上面的 try/catch 已保证失败
    // 路径提前返回，所以这里用一个局部常量把「可能未定义」收窄掉。
    const session = result as Bag;
    if (disposed) {
      // 插件在它进行中时消失了：它刚注册的工具已经随 fiber 一起拆除，但 session
      // 是这一次调用自己的责任。
      await session.closeAll().catch(() => undefined);
      return;
    }
    for (const report of session.reports) {
      if (report.error) {
        console.error(`[searchfuse] mcp ${report.serverKey}: ${report.error}`);
      }
      // 跳过只记一条信息，不进重试判定：宿主已有同名工具是稳定事实，
      // 每 30 秒重试一次同样的跳过没有任何意义。
      for (const note of report.skipped ?? []) {
        console.error(`[searchfuse] mcp ${report.serverKey}: tool ${note}; skipped`);
      }
    }
    // 有服务端没连上：安排一次稍后的重试。
    //
    // 启动那一刻的网络抖动不该让一个服务端的工具永久消失。签名机制挡的是
    // 「配置没变还重连」，但它也意味着失败之后不会自己再试——用户得改点什么
    // 才会触发下一轮。这里补上自动重试，并给一个足够长的间隔：立刻重试只会
    // 撞上同一个故障，而太长的等待又让恢复显得像卡住了。
    const failed = session.reports.filter((r: Bag) => r.error !== undefined);
    if (failed.length > 0 && !disposed && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (disposed) {
          return;
        }
        // 清掉签名，让 settle 认为「配置变了」而重新注册：失败的那些服务端
        // 要借此获得第二次机会，而已经连上的会因为同名冲突预先被 disposeTools
        // 拆掉再重建——代价是它们也要重新握手一次，但这是唯一能让两者同时
        // 成立的路径，且只在有失败时才发生。
        lastSignature = '';
        settle().catch((error) => {
          console.error(`[searchfuse] mcp retry failed: ${caughtMessage(error)}`);
        });
      }, MCP_RETRY_DELAY_MS);
      if (typeof retryTimer?.unref === 'function') {
        retryTimer.unref();
      }
    }
  };

  try {
    ctx.effect(() => () => {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      result?.closeAll().catch(() => undefined);
    }, 'modsearch: mcp sessions');
  } catch {
    // 一个已经失效的 ctx 没有 fiber 可以把拆除挂上去；于是 session 会活到进程
    // 结束，这正是宿主对一个从不卸载的插件的处理方式。
  }

  // 配置文件是插件自己的，所以宿主的 profile 重载信号永远不会为它触发。监视器
  // 由 apply 统一建一套，这里只把重载入口交出去：MCP 与独立引擎工具读的是同一
  // 份文件，各起一套定时器只会让两边在改动后短暂地看法不一致。
  settle().catch((error) => {
    console.error(`[searchfuse] mcp setup failed: ${error?.message ?? error}`);
  });
  return settle;
}

/** 服务器请求隐藏的 `<serverKey>/<toolName>` 条目。 */
function collectMcpAllowLists(servers: Bag): Bag {
  const allow: Bag = {};
  for (const [key, rawServer] of Object.entries(servers)) {
    const server = rawServer as Bag | undefined;
    if (Array.isArray(server?.allowTools)) {
      allow[key] = (server.allowTools as unknown[]).filter((name) => typeof name === 'string');
    }
  }
  return allow;
}

/** `<serverKey>/<rawName>` 映射到调用方选定的工具名。 */
function collectMcpToolNames(servers: Bag): Bag {
  const names: Bag = {};
  for (const [key, rawServer] of Object.entries(servers)) {
    const server = rawServer as Bag | undefined;
    if (isPlainObject(server?.toolNames)) {
      for (const [raw, chosen] of Object.entries((server.toolNames ?? {}) as Bag)) {
        if (typeof chosen === 'string' && chosen !== '') {
          names[`${key}/${raw}`] = chosen;
        }
      }
    }
  }
  return names;
}

/**
 * 独立引擎工具。
 *
 * 标了 `expose.tool` 的引擎就变成模型能按名字调用的工具，无论它是否也加入
 * 融合答案。这是曝光矩阵的另一半：没有它，「只做独立工具」就配置出一个任何
 * 模型都够不着的引擎。
 *
 * 注册是同步的，而且直接读配置文件，所以配置问题会在加载时暴露，并点名是哪
 * 个文件，而不是变成一个莫名其妙什么都不做的工具。
 */
function registerEngineTools(ctx: any): () => void {
  /** 上一轮注册的撤销句柄，以及那一轮对应的配置签名。 */
  const registered: Array<() => void> = [];
  let lastSignature: string | undefined;

  /**
   * 配置里决定「哪些引擎工具存在」的那一部分：名字、引擎、以及开关。
   *
   * 密钥、代理、baseURL 之类刻意不进签名：换一把密钥不该让工具在屏幕上消失
   * 又出现一次，而用户是看着那个列表点下去的。
   */
  const signatureOf = (engines: Bag): string => {
    // 遍历全部已知引擎而不是只遍历文件里那些条目：被默认关闭的引擎（在
    // OFF_UNLESS_ENABLED 里的那些）在配置里往往没有条目，只遍历文件会让
    // 签名看不出用户把它打开了——热重载于是不会重新注册它的工具。
    const shape = CARD_ENGINES.map((name) => {
      const settings = isPlainObject(engines[name]) ? engines[name] : {};
      const expose = isPlainObject(settings.expose) ? settings.expose : {};
      return [
        name,
        expose.tool === true,
        coerceBoolean(settings.enabled) !== false,
        typeof settings.toolName === 'string' ? settings.toolName.trim() : '',
      ];
    });
    return JSON.stringify(shape);
  };

  const disposeAll = () => {
    for (const undo of registered) {
      try {
        undo();
      } catch {
        // 已经消失的工具不值得当成错误上报。
      }
    }
    registered.length = 0;
  };

  const reload = () => {
    let config;
    try {
      config = readModsearchConfig();
    } catch (error) {
      // 配置文件坏了：保留现有工具，而不是先把它们撤掉再发现没东西可注册。
      // 一份写着半截 JSON 的文件不该让模型手里的工具突然消失。
      console.error(`[searchfuse] engine tools reload skipped: ${caughtMessage(error)}`);
      return;
    }
    const engines = isPlainObject(config.engines) ? config.engines : {};
    const signature = signatureOf(engines);
    if (signature === lastSignature) {
      return;
    }
    // 旧的一代先走：新工具与旧工具同名的场合，同时存在会让整趟注册失败。
    disposeAll();
    lastSignature = signature;

    const claimed = new Set(BASE_TOOL_NAMES);
    // 遍历全部已知引擎，而不是只遍历配置文件里那些条目。
    //
    // 用户可以在卡片上给一个默认关闭的引擎（arXiv、antigravity-cli）打开
    // 工具形态；那样一来配置里就有了它的条目。但反过来，一个从没被碰过的
    // 引擎在文件里没有条目，只遍历文件就永远看不到它——而「它此刻是不是
    // 开着」正是签名要比对的东西。
    //
    // 配置里可能用别名写同一个引擎（`exa` / `Exa`），`fileSettingsFor` 会按
    // 别名聚合，所以这里按键查也不会漏。
    for (const engine of CARD_ENGINES) {
      const rawSettings = fileSettingsFor(engine, config);
      const expose = isPlainObject(rawSettings.expose) ? rawSettings.expose : {};
      if (expose.tool !== true) {
        continue;
      }
      // `enabled: false` 是彻底的总开关，不只是「不参与融合」。用户关掉的引擎
      // 不能再以工具的身份出现：否则这个开关的含义就跟它说的不一样了。
      // 用 engineEnabled 而不是直接查 enabled：默认关闭的引擎从没在文件里
      // 写过 enabled，只查文件等于让它们绕过了这道闸。
      if (!engineEnabled(engine, rawSettings)) {
        continue;
      }
      const name =
        typeof rawSettings.toolName === 'string' && rawSettings.toolName.trim() !== ''
          ? rawSettings.toolName.trim()
          : `${engine}_search`;
      if (claimed.has(name)) {
        console.error(`[searchfuse] engine tool skipped: "${name}" is already taken`);
        continue;
      }
      claimed.add(name);
      const undo = ctx.tools.register(
        engineToolDefinition({ name, engine, describe: engineDescription(engine) }),
      );
      if (typeof undo === 'function') {
        registered.push(undo);
      }
    }
  };

  reload();
  return reload;
}

/** 把一个引擎做成独立工具：它自己的 source、它自己的引擎钉住项。 */
function engineToolDefinition({ name, engine, describe }: { name: string; engine: string; describe: string }): Bag {
  return {
    name,
    description: describe,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        max_results: {
          type: 'number',
          description: 'Maximum number of result items (default 8)',
        },
      },
      required: ['query'],
    },
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render: (_args: Bag, value: Bag) => [{ type: 'text', text: renderSearchEvidence(value) }],
      presentationMeta: (_args: Bag, value: Bag) => ({ sources: toSources(value.items) }),
    },
    timeoutMs: OWN_TOOL_BACKSTOP_MS,
    isConcurrencySafe: () => true,
    presentCall: (args: Bag) => ({
      card: 'generic',
      title: name,
      kind: 'search',
      rawInput: args,
    }),
    presentResult: (_args: Bag, result: Bag) => {
      if (result.isError || !result.meta || !Array.isArray(result.meta.sources)) {
        return undefined;
      }
      return { card: 'web', kind: 'search', sources: result.meta.sources, truncated: false };
    },
    async execute(args: Bag, exec: Bag) {
      if (typeof args?.query !== 'string' || args.query.trim() === '') {
        throw new Error(`${name} needs a non-empty string "query".`);
      }
      const cliArgs = [
        '-q',
        args.query,
        '--source',
        'web',
        '--engine',
        engine,
        ...ownToolBudget(),
      ];
      if (typeof args.max_results === 'number' && args.max_results > 0) {
        cliArgs.push('--max-results', String(Math.floor(args.max_results)));
      }
      const entry = await runCli(cliArgs, exec.signal);
      return {
        status: entry.status,
        source: entry.source,
        summary: entry.summary,
        items: Array.isArray(entry.items) ? entry.items : [],
        uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
      };
    },
  };
}

/** 一个孤立的引擎工具向模型描述它自己的方式。 */
function engineDescription(engine: string): string {
  const base = `Search the web through the ${engine} engine alone, pinned to it with no fallback. Use it when you want exactly this engine's index rather than a fused answer. Returns structured evidence with a summary, per-item results, and an uncertainty list.`;
  // 浏览器那一半有它自己的免密钥清单；这一半没有理由仅仅为了加一句话就复制
  // 一份，而对一个有密钥的用户来说，那句话在哪种情况下都成立。
  return base;
}

function registerConfigRoute(ctx: any): void {
  const route = {
    name: 'modsearch-config',
    kind: 'exact',
    path: '/searchfuse/config',
    handler: async (req: Bag, res: Bag) => {
      const send = (status: number, body: Bag): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // 同源守卫。裸的 webServer 注册表不继承 dsh 的 Connection 鉴权，宿主侧
      // 也不施加任何 Host/Origin 策略，所以这条路由必须自己守：
      //  - Host 必须指向本机回环，挡掉 DNS rebinding。
      //  - Origin 若存在必须同源，挡掉跨站读取响应。
      //  - POST 必须是 application/json：浏览器对非 JSON 的跨站 POST 可走
      //    “简单请求”绕开 CORS 预检，强制 JSON 会让它在预检阶段就被拒。
      const sameOrigin = (value: unknown): boolean => {
        if (typeof value !== 'string' || value === '') return true; // 非浏览器客户端没有 Origin
        try {
          const origin = new URL(value)
          return origin.hostname === '127.0.0.1'
            || origin.hostname === 'localhost'
            || origin.hostname === '[::1]'
        } catch {
          return false
        }
      }
      const hostIsLoopback = (() => {
        const raw = req.headers?.host
        if (typeof raw !== 'string' || raw === '') return true // 无 Host 头：非浏览器直连
        const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
        return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
      })()
      if (!hostIsLoopback || !sameOrigin(req.headers?.origin)) {
        send(403, { error: 'request must come from the local host' })
        return
      }
      if (req.method === 'GET') {
        try {
          const summary = engineSummary() as Bag;
          if (new URL(req.url, 'http://localhost').searchParams.has('doctor')) {
            // 探测失败时为 null：卡片于是不显示就绪区，而不是凭空编出一份。
            summary.readiness = await engineReadiness();
          }
          send(200, summary);
        } catch (error) {
          send(409, { error: caughtMessage(error) });
        }
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      // 必须是 application/json。跨站「简单请求」只能用
      // text/plain、application/x-www-form-urlencoded、multipart/form-data
      // 这三种 content-type，强制 JSON 就让它在 CORS 预检阶段被拒。
      const contentType = String(req.headers?.['content-type'] ?? '');
      if (!contentType.toLowerCase().includes('application/json')) {
        send(415, { error: 'content-type must be application/json' });
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          total += chunk.length;
          if (total > 64 * 1024) {
            send(413, { error: 'config payload too large' });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        applyCardSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        // 缓存里的判定说的是这次保存刚刚重写之前的那个文件。继续用一分钟，
        // 会在设置它的密钥刚存进来之后，告诉卡片某个引擎仍未配置。
        readinessCache = null;
        send(200, engineSummary());
      } catch (error) {
        send(400, { error: caughtMessage(error) });
      }
    },
  };
  ctx.effect(() => ctx.webServer.register(route), 'modsearch: settings route');
}

// 设置卡片的另一半，住在 socket 的这一侧，可以像 client.js 暴露 `__card` 那样
// 从测试套件里够到。它读写真实的文件和真实的环境变量，所以它是针对这两者被
// 测试的，而不是只通过 HTTP 路由测。
export const __config = { engineSummary, applyCardSettings, modsearchConfigPath };

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawnHidden(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}
