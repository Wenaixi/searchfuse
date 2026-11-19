import type { EngineSettings, Role } from '../config.ts';
import { antigravityCliProvider } from './antigravity.ts';
import { anysearchProvider } from './anysearch.ts';
import { exaProvider } from './exa.ts';
import { firecrawlProvider } from './firecrawl.ts';
import { grokCliProvider } from './grok.ts';
import { httpFetchProvider } from './httpFetch.ts';
import { keenableProvider } from './keenable.ts';
import { tavilyProvider } from './tavily.ts';
import { youcomProvider } from './youcom.ts';
import { searxngProvider } from './searxng.ts';

export type RunMode = 'search' | 'fetch';

/** 证据来自哪里。`web` 是公开索引，`x` 是 X/Twitter。 */
export type Source = 'web' | 'x';

export interface ProviderInvocation {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * 交给引擎的一个工作单元。引擎专属的开关（二进制路径、API 密钥、
 * 网络策略）不在这里：各引擎从 `settings` 里读自己需要的东西，
 * 那是由配置层从命令行参数、环境变量和配置文件解析出来的。
 */
export interface EngineRequest {
  mode: RunMode;
  query?: string;
  url?: string;
  model?: string;
  maxResults?: number;
  extraPrompt?: string;
  workdir?: string;
  timeoutMs: number;
  settings: EngineSettings;
  /** 所有已配置的 API 密钥，保留它们只是为了让提供方错误能脱敏掉每一个同级密钥。 */
  apiKeySecrets?: readonly string[];
  /**
   * 本次运行的全局网络策略：允许本地抓取器访问保留网段和私有网段。
   * Firecrawl 永远不会收到这类目标。由配置和 --allow-private-network 解析得出，
   * 缺省即为关闭。
   */
  allowPrivateNetwork?: boolean;
}

export interface EngineOutput {
  result: unknown;
  meta: {
    conversationId: string | null;
    durationSeconds: number | null;
    usage: unknown | null;
  };
}

/** 引擎解释非零退出码所需的全部信息。 */
export interface EngineFailureContext {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SearchEngine {
  name: string;
  /** 这个引擎能做的活儿。 */
  roles: Role[];
  /** 其他地方都没指定时使用的模型。没有模型时缺省。 */
  defaultModel?: string;
  /** 这个引擎现在可用吗（已安装、已登录、已配好密钥）？ */
  isAvailable: (settings: EngineSettings, env: NodeJS.ProcessEnv, role: Role) => boolean;
  /** 给人类看的一行：这个引擎要变得可用还缺什么。 */
  requirement: string;
  // 子进程引擎实现 buildInvocation + parseOutput。
  // 进程内引擎（tavily、http）改为实现 execute。
  buildInvocation?: (request: EngineRequest) => ProviderInvocation;
  parseOutput?: (stdout: string) => EngineOutput;
  execute?: (request: EngineRequest) => Promise<EngineOutput>;
  /** 把非零退出码转成可行动的消息；返回 null 表示用默认处理。 */
  describeFailure?: (context: EngineFailureContext) => string | null;
}

const ENGINES: Record<string, SearchEngine> = {
  'antigravity-cli': antigravityCliProvider,
  antigravity: antigravityCliProvider,
  agy: antigravityCliProvider,
  tavily: tavilyProvider,
  exa: exaProvider,
  firecrawl: firecrawlProvider,
  keenable: keenableProvider,
  anysearch: anysearchProvider,
  youcom: youcomProvider,
  searxng: searxngProvider,
  'grok-cli': grokCliProvider,
  grok: grokCliProvider,
  // 内置直连抓取器，规范名是 `local`。`http` 和 `direct` 保留为别名，
  // 让旧的命令行参数与配置仍能解析到它。
  local: httpFetchProvider,
  http: httpFetchProvider,
  direct: httpFetchProvider,
};

/**
 * 各角色的引擎偏好顺序，越靠前越优先。可用性会过滤这个列表，
 * 所以一台什么都没装的机器仍然能落到一个能用的引擎上。
 */
export const ROLE_PREFERENCE: Record<Role, string[]> = {
  // Firecrawl 打头阵：它的免注册免费额度在有网的裸机上就能用，
  // 这正是产品「零配置」的承诺。Keenable 是第二个免密钥引擎，
  // 所以 Firecrawl 的每日额度耗尽时裸机仍有余地。You.com 是第三个、
  // 也是最小的免密钥池（每 IP 每天 100 次），留给前两个在热门 IP 上
  // 都用尽的时候。SearXNG 排在它们之后，因为它需要一个已配置的实例
  // 但不需要密钥：它比需要密钥的引擎更早可用，但又不像它们那样在
  // 全新机器上就现成。agy 会合成并引用，但每周额度很小，所以只做
  // 免密钥引擎的后备而不是排在链首。Tavily 与 Exa 是需要密钥的备份。
  //
  // antigravity-cli 仍然列在这里，尽管它默认不参与自动路由。AGENTS.md
  // 的约定是「每个引擎默认参与，除非用 `enabled: false` 排除」，所以
  // 排除应当落在配置默认值里（config.ts 的 OFF_UNLESS_ENABLED），而不是
  // 从这个列表里删掉。把它留在这里，正是 `enabled: true` 能把它加回来的
  // 原因。
  search: [
    'firecrawl',
    'keenable',
    'anysearch',
    'youcom',
    'searxng',
    'antigravity-cli',
    'tavily',
    'exa',
  ],
  // Firecrawl 会为 JS 重的页面起云端浏览器，默认免密钥（用
  // firecrawl.keylessFetch 设 false 可退出）。agy 能抽取到指定焦点。
  // local 无需任何配置、原样返回页面，所以除非用户主动禁用它，
  // 它始终是兜底。
  fetch: ['firecrawl', 'antigravity-cli', 'local'],
  // 只有 xAI 能看见 X 内部。保留在此：这条链只有一个成员，
  // 而 x_search 只在用户主动要求时才注册。
  social: ['grok-cli'],
};

/** 永远不需要配置、作为页面抓取默认兜底的引擎。 */
export const FETCH_FLOOR = 'local';

export function resolveEngine(engineName: string): SearchEngine {
  const engine = findEngine(engineName);
  if (!engine) {
    throw new Error(`Unknown engine: ${engineName}. Known engines: ${listEngines().join(', ')}.`);
  }
  return engine;
}

export function findEngine(engineName: string): SearchEngine | undefined {
  // 只用自有属性：注册表是个普通对象，而裸下标会走原型链，于是像
  // "constructor" 这样的名字会取到 Object 的构造函数，被当成真值的“引擎”。
  const key = engineName.trim().toLowerCase();
  return Object.hasOwn(ENGINES, key) ? ENGINES[key] : undefined;
}

/** 每个已注册的引擎，各出现一次，按注册顺序。 */
export function allEngines(): SearchEngine[] {
  return [...new Set(Object.values(ENGINES))];
}

export function enginesForRole(role: Role): SearchEngine[] {
  return allEngines().filter((engine) => engine.roles.includes(role));
}

export function listEngines(): string[] {
  return allEngines().map((engine) => engine.name);
}
