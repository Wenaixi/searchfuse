import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 运行期安全：providers/index.ts 在运行时并不从这个模块导入任何东西
// （它对 config 的导入只是类型级的），所以这里不会形成循环导入。
import { findEngine, listEngines } from './providers/index.ts';
import { splitApiKeys } from './util/apiKeys.ts';
import { resolveExplicitProxy } from './util/explicitProxy.ts';
import { maskUrlCredentials, redactSecrets } from './util/redact.ts';

// 分层配置：命令行参数 > 环境变量 > ~/.modsearch/config.json > 内置默认。
//
// `engine` 是软偏好。`engines.<name>.enabled` 决定自动路由可以使用哪些引擎，
// 缺省即视为启用。其余一切由引擎自身能力决定。凭据与可执行文件路径也放在
// `engines` 下面。

export type Role = 'search' | 'fetch' | 'social';

export const ROLES: Role[] = ['search', 'fetch', 'social'];

/** 首选引擎存放在顶层字段的那个角色。 */
export const CONFIGURED_ROLE: Role = 'search';

export type AggregateMode = 'rrf' | 'chain';

export interface AggregateConfig {
  /** 'rrf' 并发融合，'chain' 一次试一个引擎。 */
  mode?: AggregateMode;
  /**
   * 一次融合运行的墙钟预算，所有来源共享。过了这个点，还没回来的记为失败，
   * 运行带着已到达的部分继续。链式模式下忽略此项——那条路有自己的单引擎预算。
   */
  deadlineMs?: number;
  /**
   * 融合结果从缓存提供的时间，毫秒。0 表示关闭缓存。默认 5 分钟：足够长，
   * 让正在缩小问题范围的 agent 复用自己的答案；也足够短，让关于今日新闻的
   * 搜索结果读到的时候还没过时。
   */
  cacheTtlMs?: number;
}

/**
 * 已注册、可解析、可诊断，但在用户主动要求之前不参与自动路由的引擎。
 *
 * 这不等同于从角色偏好里删掉该引擎：AGENTS.md 承诺每个引擎默认都参与，
 * 排除某个引擎的唯一手段是 `enabled: false`，所以这种排除必须是一个用户
 * 可以随手切换的普通设置，而不是路由器里的特例。这里的值就是配置文件
 * 对该引擎只字未提时它得到的默认。
 *
 * antigravity-cli 之所以在这里，是因为它靠模型合成结果、要花一分钟甚至更久，
 * 超过任何有用的融合预算；留在链里也只能被跳过。想要它的用户写上
 * `engines.antigravity-cli.enabled: true` 就能把它拿回来。
 */
const OFF_UNLESS_ENABLED: Record<string, true> = {
  'antigravity-cli': true,
};

export interface EngineSettings {
  apiKey?: string;
  model?: string;
  bin?: string;
  /** 是否参与自动路由。未设置即视为启用。 */
  enabled?: boolean;
  /**
   * 允许 Firecrawl 在没有 API key 的情况下抓取公开 URL。默认开启
   * （未设置即视为开启）；设为 false 可让页面抓取不走 Firecrawl 的云端。
   */
  keylessFetch?: boolean;
  /**
   * HTTP 引擎（tavily、exa、firecrawl、keenable）的端点基址，用来替换官方主机：
   * 可以是第三方兼容网关、代理或自托管部署。引擎会追加自己文档里规定的路径
   * （`/search`、`/v2/scrape`），并把 API key 发给这里指定的主机——这既是
   * 该设置的意义所在，也正是它的风险所在：只填你愿意托付这把 key 的主机。
   */
  baseURL?: string;
  /**
   * 单引擎代理。未设置则跟随机器的 http_proxy / https_proxy / no_proxy；
   * `direct` 或 `none` 强制只有这个引擎走直连；完整的 http(s) URL 则只让这个
   * 引擎走该代理。所有引擎共享同一个进程，所以这是让其中一个引擎走不同路由的
   * 唯一办法——让无 key 的引擎走本地中继、让区域 API 走区域出口，或者让某个
   * 引擎绕过机器其余部分需要的代理。
   */
  proxy?: string;
  /**
   * 这个引擎如何参与融合搜索。两个键的默认值都是
   * `aggregate: true, tool: false`，这也是在这些设置出现之前写下的配置所得到的行为。
   *
   * - `aggregate` — 它的结果进入 `web_search` 的融合。
   * - `tool` — 它同时成为一个独立工具，可以按名称调用。
   *
   * 两者可以同时开启：这个引擎既参与融合答案，又能在模型只想要这一个来源时
   * 被直接点名调用。
   */
  expose?: {
    aggregate?: boolean;
    tool?: boolean;
  };
  /**
   * `expose.tool` 开启时独立工具使用的名称。默认是
   * `<engine>_search`。两个引擎不能占用同一个名称，内置工具的保留名也会被拒绝。
   */
  toolName?: string;
}

export interface ModsearchConfig {
  /** Engine for searching. Empty means: use the best one available here. */
  engine?: string;
  engines?: Record<string, EngineSettings>;
  /**
   * How several sources combine. `rrf` (the default) runs the eligible engines
   * concurrently and fuses their lists by reciprocal rank, so agreement
   * between independent engines outranks one engine's own favourite. `chain`
   * keeps the original behavior: try one engine at a time and stop at the
   * first that answers.
   */
  aggregate?: AggregateConfig;
  /**
   * MCP 服务端列表，由插件在加载时读取并注册成工具。这一段的形状由
   * mcp 客户端自己定义（transport/url/headers/allowTools/toolNames），
   * 配置层只负责原样搬运，不解释内容。
   */
  mcp?: Record<string, Record<string, unknown>>;
  /**
   * Quota cooldown switch: 'on' (default) or 'off'. On, a quota-spent engine is
   * remembered and moved to the back of the fallback chain until it recovers.
   * Off, nothing is read from or written to state.json and routing is unchanged.
   */
  cooldown?: string;
  /**
   * Global network policy, not an engine setting: allow reserved and private
   * address ranges in the local fetcher. It never authorizes sending a target
   * that is, or resolves to, a reserved address to Firecrawl. Off by default.
   */
  allowPrivateNetwork?: boolean;
}

/** Shapes older configs used before role preferences collapsed to one field. */
interface LegacyRoleConfig {
  engine?: string;
}

export const CONFIG_DIR = path.join(os.homedir(), '.modsearch');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Resolved at call time so a faked HOME (tests) redirects the config too. */
export function currentConfigPath(): string {
  return path.join(os.homedir(), '.modsearch', 'config.json');
}

type StringEngineSetting = 'apiKey' | 'model' | 'bin' | 'baseURL';

const ENV_BINDINGS: Record<string, Partial<Record<StringEngineSetting, string>>> = {
  tavily: { apiKey: 'TAVILY_API_KEY', baseURL: 'TAVILY_BASE_URL' },
  exa: { apiKey: 'EXA_API_KEY', baseURL: 'EXA_BASE_URL' },
  firecrawl: { apiKey: 'FIRECRAWL_API_KEY', baseURL: 'FIRECRAWL_BASE_URL' },
  keenable: { apiKey: 'KEENABLE_API_KEY', baseURL: 'KEENABLE_BASE_URL' },
};

const SETTABLE_ENGINE_FIELDS: Array<keyof EngineSettings> = [
  'apiKey',
  'model',
  'bin',
  'enabled',
  'baseURL',
  'keylessFetch',
  'proxy',
];

/** Engines that used to be pinned globally, mapped to the role they serve. */
const LEGACY_ENGINE_ROLES: Record<string, Role> = {
  'antigravity-cli': 'search',
  antigravity: 'search',
  agy: 'search',
  tavily: 'search',
  'grok-cli': 'social',
  grok: 'social',
  http: 'fetch',
  direct: 'fetch',
};

/** Aliases the registry accepts, mapped to the name settings are stored under. */
const CANONICAL_ENGINE: Record<string, string> = {
  antigravity: 'antigravity-cli',
  agy: 'antigravity-cli',
  grok: 'grok-cli',
  http: 'local',
  direct: 'local',
};

/**
 * The canonical name for an engine, folding aliases (agy, http, direct, ...).
 * Own properties only: the aliases table is a plain object, and a bare index
 * walks the prototype chain, so "constructor" resolved to Object's constructor
 * function, read as truthy, and a `config set constructor.apiKey` wrote the
 * key onto that global, printed success, and saved nothing.
 */
export function canonicalEngineName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return Object.hasOwn(CANONICAL_ENGINE, trimmed) ? CANONICAL_ENGINE[trimmed] : trimmed;
}

/** JSON-parsed objects only: null, arrays, and prototype residents are not settings. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LegacyConfig {
  /** v2: one global provider name. */
  provider?: string;
  providers?: Record<string, EngineSettings>;
  /** v3.0-3.1: one engine per role. */
  search?: LegacyRoleConfig;
  fetch?: LegacyRoleConfig;
  social?: LegacyRoleConfig;
}

/** 'true'/'false' (any case) or a real boolean to a boolean, else undefined. */
export function coerceBoolean(value: unknown): boolean | undefined {
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
 * Read a config file into the current shape. Two migrations run here, always,
 * so an older file keeps working without the user touching it:
 *
 * - Alias engine keys (agy, antigravity, grok, http, direct) fold onto their
 *   canonical name, and configs written before roles existed (a global
 *   `provider` plus a `providers` map, or a per-role search/fetch/social block)
 *   collapse to the top-level `engine` preference.
 * - `allowPrivateNetwork` moved from a per-engine string to a top-level boolean.
 *   The old `engines.<name>.allowPrivateNetwork` position and the old `"true"`/
 *   `"false"` string form are both read and promoted to the new top-level key.
 */
/**
 * Every string apiKey the raw file carried, including ones the alias fold
 * displaced (two alias spellings of one engine can each bring a key; the merge
 * keeps one). A displaced key is gone from the config object but may survive
 * in another field's text, so config show must still know to scrub it. Keyed
 * by the migrated config object: this never touches the JSON shape.
 */
const SEEN_API_KEYS = new WeakMap<ModsearchConfig, string[]>();

export function migrateLegacyConfig(raw: ModsearchConfig & LegacyConfig): ModsearchConfig {
  const hasLegacy = Boolean(raw.providers || raw.provider || raw.search || raw.fetch || raw.social);
  const seenApiKeys = new Set<string>();

  // A top-level string form ("true"/"false") is coerced here too.
  let allowPrivateNetwork = coerceBoolean(
    (raw as { allowPrivateNetwork?: unknown }).allowPrivateNetwork,
  );

  // Merge per engine, not per map: a new `engines.tavily.model` next to an old
  // `providers.tavily.apiKey` used to drop the key entirely. The retired
  // per-engine allowPrivateNetwork flag is lifted out to the top level.
  //
  // Null prototype on purpose: the entry names come from a hand-editable file,
  // and on a normal object literal `engines["__proto__"] = {...}` does not
  // define a property, it SETS THE PROTOTYPE. The entry then hides from
  // Object.entries and JSON.stringify (doctor would report an inherited key as
  // present, and the next write would silently drop it) while dot-access still
  // sees it. On a null-prototype object the same name is an ordinary own
  // property: visible, serialized, and judged like any unknown engine.
  const engines: Record<string, EngineSettings> = Object.create(null);
  const fold = (source: Record<string, Record<string, unknown>> | undefined) => {
    if (!isPlainObject(source)) {
      return;
    }
    for (const [name, rawSettings] of Object.entries(source)) {
      // A hand-edited entry that is not an object (a string, an array) has no
      // fields to merge; skip it rather than spreading its characters.
      if (!isPlainObject(rawSettings)) {
        continue;
      }
      if (typeof rawSettings.apiKey === 'string') {
        for (const apiKey of splitApiKeys(rawSettings.apiKey)) {
          seenApiKeys.add(apiKey);
        }
      }
      const canonical = canonicalEngineName(name);
      const {
        allowPrivateNetwork: legacyFlag,
        keylessFetch: rawKeylessFetch,
        enabled: rawEnabled,
        ...rest
      } = rawSettings;
      if (legacyFlag !== undefined) {
        allowPrivateNetwork ??= coerceBoolean(legacyFlag);
      }
      const keylessFetch = coerceBoolean(rawKeylessFetch);
      const enabled = coerceBoolean(rawEnabled);
      engines[canonical] = {
        ...engines[canonical],
        ...(rest as EngineSettings),
        ...(keylessFetch === undefined ? {} : { keylessFetch }),
        ...(enabled === undefined ? {} : { enabled }),
      };
    }
  };
  fold(raw.providers as Record<string, Record<string, unknown>> | undefined);
  fold(raw.engines as Record<string, Record<string, unknown>> | undefined);

  // An engine entry that held nothing but the migrated flag is now empty: drop
  // it so the effective config does not show a hollow `local: {}`.
  for (const [name, settings] of Object.entries(engines)) {
    if (Object.keys(settings).length === 0) {
      delete engines[name];
    }
  }

  // Any older shape collapses to the preference: a per-role search engine, or a
  // v2 global provider that happened to be a search engine. A current config
  // keeps its `engine` verbatim, empty string included.
  const legacySearch = raw.search?.engine?.trim();
  const pinned = raw.provider?.trim();
  const fromPin =
    pinned && Object.hasOwn(LEGACY_ENGINE_ROLES, pinned) && LEGACY_ENGINE_ROLES[pinned] === 'search'
      ? canonicalEngineName(pinned)
      : undefined;
  const engine = hasLegacy ? raw.engine?.trim() || legacySearch || fromPin : raw.engine;

  const config: ModsearchConfig = { engines };
  if (engine !== undefined) {
    config.engine = engine;
  }
  if (raw.cooldown !== undefined) {
    config.cooldown = raw.cooldown;
  }
  if (allowPrivateNetwork !== undefined) {
    config.allowPrivateNetwork = allowPrivateNetwork;
  }
  // This function rebuilds the config from a list of known keys, so a new
  // top-level section is dropped unless it is carried across here. Omitting
  // one would not fail loudly: the read path would just report the default.
  if (raw.aggregate !== undefined) {
    config.aggregate = raw.aggregate;
  }
  // 同一个陷阱的第二个实例：MCP 服务端配置住在这一份文件里（D3 决定的），
  // 而这里是一次白名单式的重建，不搬运就会在每一次 `config set` 之后把整个
  // mcp 段抹掉。它不会报错，只会让工具在下次加载时安静地消失。
  if (raw.mcp !== undefined) {
    config.mcp = raw.mcp;
  }
  if (seenApiKeys.size > 0) {
    SEEN_API_KEYS.set(config, [...seenApiKeys]);
  }
  return config;
}

export function loadConfigFile(configPath = currentConfigPath()): ModsearchConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    // Only a missing file means "no config". Anything else (permissions, a
    // directory in its place) is a real problem worth naming, not a silent
    // downgrade to defaults.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(
      `Cannot read ${configPath}: ${(error as Error).message}. Fix the file or its permissions.`,
    );
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return migrateLegacyConfig(parsed as ModsearchConfig & LegacyConfig);
  } catch (error) {
    throw new Error(
      `Failed to parse ${configPath}: ${(error as Error).message}. Fix or delete the file.`,
    );
  }
}

/** The engine the user asked for, if any. */
export function chosenEngine(config: ModsearchConfig): string | undefined {
  return config.engine?.trim() || undefined;
}

/** Whether the quota cooldown is active. On by default, off only when set to 'off'. */
export function cooldownEnabled(config: ModsearchConfig): boolean {
  return config.cooldown?.trim().toLowerCase() !== 'off';
}

/** Whether reserved and private address ranges are allowed. Off by default. */
export function allowsPrivateNetwork(config: ModsearchConfig): boolean {
  return config.allowPrivateNetwork === true;
}

/** Fused by default; `chain` restores the one-engine-at-a-time behavior. */
export function aggregateMode(config: ModsearchConfig): AggregateMode {
  return config.aggregate?.mode === 'chain' ? 'chain' : 'rrf';
}

/** Total wall-clock budget for a fused run, in milliseconds. */
export function aggregateDeadlineMs(config: ModsearchConfig): number {
  const configured = config.aggregate?.deadlineMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return 8_000;
}

/** How long a fused result stays cacheable. 0 disables caching. */
export function aggregateCacheTtlMs(config: ModsearchConfig): number {
  const configured = config.aggregate?.cacheTtlMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return 5 * 60 * 1000;
}

/**
 * How one engine exposes itself. Missing keys take the defaults a config
 * written before these settings existed should get.
 */
export function exposeOf(settings: EngineSettings): { aggregate: boolean; tool: boolean } {
  const expose = isPlainObject(settings.expose) ? settings.expose : {};
  return {
    aggregate: expose.aggregate !== false,
    tool: expose.tool === true,
  };
}

/** Settings for one engine, with env vars overriding the file. */
export function engineSettings(
  engineName: string,
  config: ModsearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): EngineSettings {
  const engines = isPlainObject(config.engines) ? config.engines : {};
  const fromFile =
    Object.hasOwn(engines, engineName) && isPlainObject(engines[engineName])
      ? (engines[engineName] as EngineSettings)
      : {};
  const bindings = Object.hasOwn(ENV_BINDINGS, engineName) ? ENV_BINDINGS[engineName] : {};

  const settings: EngineSettings = { ...fromFile };
  // An engine that is off unless asked takes the default only when the file
  // has no opinion. Two things count as an opinion: an explicit enabled
  // value here, and being the engine the file pins as its preference — pinning
  // an engine and then refusing to run it is the config arguing with itself.
  if (
    Object.hasOwn(OFF_UNLESS_ENABLED, engineName) &&
    settings.enabled === undefined &&
    chosenEngine(config) !== engineName
  ) {
    settings.enabled = false;
  }
  for (const [field, envName] of Object.entries(bindings) as Array<[StringEngineSetting, string]>) {
    const value = env[envName]?.trim();
    const present = field === 'apiKey' ? splitApiKeys(value).length > 0 : Boolean(value);
    if (value && present) {
      settings[field] = value;
    }
  }
  return settings;
}

/**
 * Set a dotted key and persist with 0600 perms. Two shapes:
 *   search.engine tavily             role to engine
 *   engines.tavily.apiKey <key>      engine setting
 * The `engines.` prefix may be dropped: `tavily.apiKey` works too.
 */
export function setConfigValue(
  dottedKey: string,
  value: string,
  configPath = currentConfigPath(),
): void {
  const config = loadConfigFile(configPath);
  const parts = dottedKey.split('.').filter(Boolean);

  // `engine <name>` is the whole role surface. `search.engine` still works so
  // muscle memory from the previous shape does not hit an error. A non-empty
  // value must name a real engine: the router tolerates a typo in a
  // hand-edited file with a warning, but the CLI has no reason to create one,
  // and doctor would echo the bad value back (which, pasted secrets included,
  // is text better refused than displayed). Empty returns to automatic.
  const isEngineKey =
    (parts.length === 1 && parts[0] === 'engine') ||
    (parts.length === 2 && parts[0] === 'search' && parts[1] === 'engine');
  if (isEngineKey) {
    const trimmed = value.trim();
    if (trimmed !== '' && !findEngine(trimmed)) {
      throw new Error(`Unknown engine: ${value}. Known engines: ${listEngines().join(', ')}.`);
    }
    config.engine = trimmed === '' ? '' : canonicalEngineName(trimmed);
  } else if (parts.length === 1 && parts[0] === 'cooldown') {
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') {
      throw new Error(`Invalid cooldown value: ${value}. Use on or off.`);
    }
    config.cooldown = normalized;
  } else if (parts.length === 1 && parts[0] === 'allowPrivateNetwork') {
    const parsed = coerceBoolean(value);
    if (parsed === undefined) {
      throw new Error(`Invalid allowPrivateNetwork value: ${value}. Use true or false.`);
    }
    config.allowPrivateNetwork = parsed;
  } else {
    const [rawEngineName, field] =
      parts[0] === 'engines' ? [parts[1], parts[2]] : [parts[0], parts[1]];
    if (!rawEngineName || !field) {
      throw new Error(
        `Invalid config key: ${dottedKey}. Use "engine" or "engines.<engine>.<${SETTABLE_ENGINE_FIELDS.join('|')}>".`,
      );
    }
    // The file is read back by exact lowercase canonical key, so an unknown or
    // miscased name would be stored, reported saved, and never read again.
    // Refusing here turns silent data loss into an immediate, fixable error.
    const engineName = canonicalEngineName(rawEngineName);
    if (!findEngine(engineName)) {
      throw new Error(
        `Unknown engine: ${rawEngineName}. Known engines: ${listEngines().join(', ')}.`,
      );
    }
    if (!SETTABLE_ENGINE_FIELDS.includes(field as keyof EngineSettings)) {
      throw new Error(
        `Unknown engine setting: ${field}. Use ${SETTABLE_ENGINE_FIELDS.join(', ')}.`,
      );
    }
    // A hand-edited file can put anything at these positions. Refuse to spread
    // a non-object rather than corrupting the write.
    if (config.engines !== undefined && !isPlainObject(config.engines)) {
      throw new Error(
        `The "engines" section of the config file is not an object. Fix or remove it.`,
      );
    }
    if (config.engines?.[engineName] !== undefined && !isPlainObject(config.engines[engineName])) {
      throw new Error(
        `The "engines.${engineName}" entry of the config file is not an object. Fix or remove it.`,
      );
    }
    if (field === 'keylessFetch' || field === 'enabled') {
      const parsed = coerceBoolean(value);
      if (parsed === undefined) {
        throw new Error(`Invalid ${field} value: ${value}. Use true or false.`);
      }
      if (field === 'enabled' && parsed) {
        const settings = config.engines?.[engineName];
        if (settings) {
          delete settings.enabled;
          if (Object.keys(settings).length === 0) {
            delete config.engines?.[engineName];
          }
        }
        writeConfigFile(config, configPath);
        return;
      }
      config.engines ??= {};
      config.engines[engineName] ??= {};
      config.engines[engineName][field] = parsed;
      writeConfigFile(config, configPath);
      return;
    }
    if (field === 'baseURL') {
      const trimmed = value.trim();
      // Empty unsets the override, back to the official endpoint. Anything else
      // must be a full origin, refused here rather than as a confusing fetch
      // failure at search time.
      if (trimmed === '') {
        delete config.engines?.[engineName]?.baseURL;
        writeConfigFile(config, configPath);
        return;
      }
      if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error(
          `Invalid baseURL: ${value}. Use a full http(s) URL, e.g. https://api.example.com`,
        );
      }
      value = trimmed;
    }
    if (field === 'proxy') {
      const trimmed = value.trim();
      // Empty unsets the override, back to following the environment. The
      // stored value is a keyword or a URL, never a half-written one: the
      // router resolves it on every run, so a value saved here that it cannot
      // act on would fail far from this command.
      if (trimmed === '') {
        delete config.engines?.[engineName]?.proxy;
        writeConfigFile(config, configPath);
        return;
      }
      const resolved = resolveExplicitProxy(trimmed);
      if (resolved === undefined) {
        throw new Error(`Invalid proxy: "${value}". Use direct, none, or a full http(s) URL.`);
      }
      value = trimmed;
    }
    config.engines ??= {};
    config.engines[engineName] ??= {};
    config.engines[engineName][field as StringEngineSetting] = value;
  }

  writeConfigFile(config, configPath);
}

/**
 * The config directory holds key material, so it is created 0700. An existing
 * directory keeps whatever mode it has: re-tightening on every write would
 * override permissions a user set deliberately, and the files inside carry
 * their own 0600. chmod is best-effort for platforms without POSIX modes.
 */
function ensurePrivateDir(dir: string): void {
  if (fs.existsSync(dir)) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort on platforms without chmod
  }
}

/**
 * Write key material as a fresh 0600 file and rename it into place.
 * writeFileSync's mode only applies when it CREATES the file: rewriting an
 * existing 0644 config would land the new key world-readable until the chmod,
 * and a pre-placed file owned by someone else would take the content into
 * their inode with the chmod failing silently. A same-directory temp file is
 * born 0600 and rename replaces the inode, so neither window exists.
 */
function writePrivateFile(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath));
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = path.join(path.dirname(filePath), `.config.${unique}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the rename failure is the error worth reporting
    }
    throw error;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort on platforms without chmod
  }
}

function writeConfigFile(config: ModsearchConfig, configPath: string): void {
  writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The starter file holds nothing but the shape. Pre-filling every engine and
 * every default looked helpful and was not: it buried the real decisions in
 * placeholders, and writing today's defaults into the file freezes them, so a
 * later change to a default model would be silently overridden by this copy.
 */
export const CONFIG_TEMPLATE: ModsearchConfig = {
  // Empty means: use the best engine available on this machine.
  engine: '',
  engines: {},
};

/** Write a starter config. Refuses to overwrite unless force is set. */
export function initConfigFile(configPath = currentConfigPath(), force = false): void {
  if (!force && fs.existsSync(configPath)) {
    throw new Error(`${configPath} already exists. Use --force to overwrite.`);
  }
  writePrivateFile(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`);
}

/** Every API key the file or environment holds, displaced fold casualties included. */
function knownApiKeys(config: ModsearchConfig, env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>(SEEN_API_KEYS.get(config) ?? []);
  const enginesRoot = isPlainObject(config.engines) ? config.engines : {};
  for (const entry of Object.values(enginesRoot)) {
    if (isPlainObject(entry) && typeof entry.apiKey === 'string') {
      for (const apiKey of splitApiKeys(entry.apiKey)) {
        keys.add(apiKey);
      }
    }
  }
  for (const bindings of Object.values(ENV_BINDINGS)) {
    const variable = bindings.apiKey;
    for (const apiKey of splitApiKeys(variable ? env[variable] : undefined)) {
      keys.add(apiKey);
    }
  }
  return [...keys];
}

/**
 * Redact every known key from a value tree's strings, longest key first so an
 * overlapping shorter key cannot split a longer one into survivable halves.
 * No length assumption at all: the config layer imposes no minimum on an
 * apiKey and gateways issue what they issue, so even a one-character key is
 * scrubbed from every string it appears in. A short key shreds the view's
 * readability, and that is the right failure: this output exists to be pasted
 * into issues, and a shredded view is safe where a readable one leaking a
 * credential is not.
 *
 * Values ONLY, by structural contract: every property name in the rendered
 * view is a compile-time constant or a registry engine name, and user data
 * (hand-written engine spellings included) lives inside values.
 */
function redactValues<T>(value: T, keys: string[]): T {
  const ordered = [...keys].sort((a, b) => b.length - a.length);
  const scrub = (text: string): string => {
    let out = text;
    for (const key of ordered) {
      if (key.length > 0) {
        out = out.split(key).join('[redacted]');
      }
    }
    return out;
  };
  const walk = (node: unknown): unknown => {
    // The known-key split runs with no length floor, then the shape net
    // (redactSecrets) catches token-shaped strings nobody declared as a key:
    // an sk- credential pasted into a model note, an api_key= parameter in a
    // gateway URL. A secret with no known shape living only in a non-secret
    // field stays unknowable; the security doc says so.
    if (typeof node === 'string') return redactSecrets(scrub(node));
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of Object.entries(node)) {
        out[key] = walk(entry);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Render the effective config: what modsearch will actually use, not just what
 * the file says. Environment variables are merged in the way `engineSettings`
 * merges them, every value is tagged with where it came from (`file` or `env`),
 * alias engine keys (agy, antigravity, grok, direct) are shown under their
 * canonical name, and API keys stay masked.
 *
 * Redaction is a boundary here, not a per-field habit: this output's product
 * contract is being safe to paste into an issue. A key is masked in its own
 * field, scrubbed from every other field on the same row (a key pasted into a
 * gateway URL or a model note used to print in full one field over from its
 * own mask), URL credentials are masked, unknown engine names become note
 * values rather than property names, and a final pass scrubs every known key
 * from every string in the tree.
 */
export function renderEffectiveConfig(
  config: ModsearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tag = (value: string | boolean, source: 'file' | 'env') => `${value} (${source})`;

  const out: Record<string, unknown> = {};
  out.engine = config.engine ? tag(config.engine, 'file') : '(unset: automatic)';
  out.cooldown = config.cooldown ? tag(config.cooldown, 'file') : 'on (default)';
  out.allowPrivateNetwork =
    config.allowPrivateNetwork === undefined
      ? 'false (default)'
      : tag(String(config.allowPrivateNetwork), 'file');

  const engines: Record<string, Record<string, string>> = {};
  const notes: string[] = [];
  const ensure = (name: string) => {
    engines[name] ??= {};
    return engines[name];
  };

  const shown = (field: string, value: unknown, entryKeys: string[]): string => {
    if (field === 'apiKey') {
      return maskKeys(String(value));
    }
    let text = String(value);
    if (field === 'baseURL' || field === 'proxy') {
      // Both can carry credentials in their userinfo (`http://user:pass@host`),
      // and this output is meant to be safe to paste into an issue.
      text = maskUrlCredentials(text);
    }
    // Same-row wash: the row's own key must not survive in its other fields.
    for (const entryKey of entryKeys) {
      text = text.split(entryKey).join('[redacted]');
    }
    return text;
  };

  // File settings first, alias keys folded onto their canonical engine. An
  // engine name the registry does not know never becomes a property name: a
  // hand-written spelling is user data, and user data lives in values only.
  for (const [rawName, settings] of Object.entries(config.engines ?? {})) {
    if (!isPlainObject(settings)) {
      notes.push(`engines entry is not an object and was ignored`);
      continue;
    }
    const canonical = canonicalEngineName(rawName);
    if (!findEngine(canonical)) {
      notes.push(`unknown engine entry (not one of: ${listEngines().join(', ')})`);
      continue;
    }
    const target = ensure(canonical);
    const entryKeys = splitApiKeys(
      typeof settings.apiKey === 'string' ? settings.apiKey : undefined,
    );
    for (const field of SETTABLE_ENGINE_FIELDS) {
      const value = settings[field];
      if (value === undefined) {
        continue;
      }
      target[field] = tag(shown(field, value, entryKeys), 'file');
    }
  }

  // Environment overrides, exactly the bindings engineSettings applies. An env
  // value wins over the file, so it overwrites the tag too.
  for (const [engineName, bindings] of Object.entries(ENV_BINDINGS)) {
    const canonical = canonicalEngineName(engineName);
    const entryKeys = splitApiKeys(bindings.apiKey ? env[bindings.apiKey] : undefined);
    for (const [field, envName] of Object.entries(bindings) as Array<
      [StringEngineSetting, string]
    >) {
      const value = env[envName]?.trim();
      if (!value || (field === 'apiKey' && splitApiKeys(value).length === 0)) {
        continue;
      }
      ensure(canonical)[field] = tag(shown(field, value, entryKeys), 'env');
    }
  }

  out.engines = engines;
  if (notes.length > 0) {
    out.notes = notes;
  }
  // The last line of defense: no known key survives in any string of the view,
  // whatever field or note it was pasted into.
  return JSON.stringify(redactValues(out, knownApiKeys(config, env)), null, 2);
}

function maskKey(key: string): string {
  if (key.length <= 8) {
    return '****';
  }
  return `${key.slice(0, 6)}...${key.slice(-2)}`;
}

function maskKeys(value: string): string {
  const keys = splitApiKeys(value);
  return keys.length > 0 ? keys.map(maskKey).join(', ') : '****';
}
