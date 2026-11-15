import type { EngineSettings, Role } from '../config.ts';
import { antigravityCliProvider } from './antigravity.ts';
import { exaProvider } from './exa.ts';
import { firecrawlProvider } from './firecrawl.ts';
import { grokCliProvider } from './grok.ts';
import { httpFetchProvider } from './httpFetch.ts';
import { keenableProvider } from './keenable.ts';
import { tavilyProvider } from './tavily.ts';
import { youcomProvider } from './youcom.ts';
import { searxngProvider } from './searxng.ts';
import { arxivProvider } from './arxiv.ts';

export type RunMode = 'search' | 'fetch';

/** Where evidence comes from. `web` is the public index, `x` is X/Twitter. */
export type Source = 'web' | 'x';

export interface ProviderInvocation {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * One unit of work handed to an engine. Engine-specific knobs (binary paths,
 * API keys, network policy) are not fields here: each engine reads what it
 * needs from `settings`, which the config layer resolved from flags,
 * environment, and file.
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
  /** All configured API keys, retained only so provider errors can redact every sibling key. */
  apiKeySecrets?: readonly string[];
  /**
   * Global network policy for this run: allow the local fetcher to reach
   * reserved and private ranges. Firecrawl never receives those targets.
   * Resolved from config and --allow-private-network. Off when absent.
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

/** Everything an engine needs to explain a non-zero exit. */
export interface EngineFailureContext {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SearchEngine {
  name: string;
  /** Jobs this engine can do. */
  roles: Role[];
  /** Model used when nothing else specifies one. Absent when it has no model. */
  defaultModel?: string;
  /** Is this engine usable right now (installed, signed in, keyed)? */
  isAvailable: (settings: EngineSettings, env: NodeJS.ProcessEnv, role: Role) => boolean;
  /** One line for humans: what this engine needs to become available. */
  requirement: string;
  // Subprocess engines implement buildInvocation + parseOutput.
  // In-process engines (tavily, http) implement execute instead.
  buildInvocation?: (request: EngineRequest) => ProviderInvocation;
  parseOutput?: (stdout: string) => EngineOutput;
  execute?: (request: EngineRequest) => Promise<EngineOutput>;
  /** Turn a non-zero exit into an actionable message, or null for the default. */
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
  youcom: youcomProvider,
  searxng: searxngProvider,
  arxiv: arxivProvider,
  'grok-cli': grokCliProvider,
  grok: grokCliProvider,
  // The built-in direct fetcher, canonically `local`. `http` and `direct` stay
  // as aliases so old flags and configs keep resolving to it.
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
    'youcom',
    'searxng',
    'arxiv',
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
  // Own properties only: the registry is a plain object, and a bare index
  // walks the prototype chain, so a name like "constructor" would come back
  // as Object's constructor function and read as a truthy "engine".
  const key = engineName.trim().toLowerCase();
  return Object.hasOwn(ENGINES, key) ? ENGINES[key] : undefined;
}

/** Every registered engine, once each, in registration order. */
export function allEngines(): SearchEngine[] {
  return [...new Set(Object.values(ENGINES))];
}

export function enginesForRole(role: Role): SearchEngine[] {
  return allEngines().filter((engine) => engine.roles.includes(role));
}

export function listEngines(): string[] {
  return allEngines().map((engine) => engine.name);
}
