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
  /** 用于搜索的引擎。空表示使用本机可用的最佳引擎。 */
  engine?: string;
  engines?: Record<string, EngineSettings>;
  /**
   * 多个来源如何组合。`rrf`（默认值）并发运行符合条件的引擎，按倒数排名融合
   * 它们的列表，于是多个独立引擎一致认可的结果会压过单个引擎自己的偏好。
   * `chain` 保留原有行为：一次试一个引擎，在第一个给出答案的引擎处停下。
   */
  aggregate?: AggregateConfig;
  /**
   * MCP 服务端列表，由插件在加载时读取并注册成工具。这一段的形状由
   * mcp 客户端自己定义（transport/url/headers/allowTools/toolNames），
   * 配置层只负责原样搬运，不解释内容。
   */
  mcp?: Record<string, Record<string, unknown>>;
  /**
   * 配额冷却开关：'on'（默认）或 'off'。开启时，配额用尽的引擎会被记住并
   * 移到回退链的末尾，直到它恢复。关闭时，既不读也不写 state.json，路由行为不变。
   */
  cooldown?: string;
  /**
   * 全局网络策略，不是引擎设置：允许本地抓取器访问保留地址与私有地址段。
   * 它从不授权把保留地址（或解析到保留地址的目标）发给 Firecrawl。默认关闭。
   */
  allowPrivateNetwork?: boolean;
}

/** 角色偏好收敛成单个字段之前，旧配置使用的形状。 */
interface LegacyRoleConfig {
  engine?: string;
}

export const CONFIG_DIR = path.join(os.homedir(), '.modsearch');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** 在调用时才解析，这样伪造的 HOME（测试用）也会把配置重定向过去。 */
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

/** 过去被全局固定的引擎，映射到它们承担的角色。 */
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

/** 注册表接受的别名，映射到设置实际存储时使用的名称。 */
const CANONICAL_ENGINE: Record<string, string> = {
  antigravity: 'antigravity-cli',
  agy: 'antigravity-cli',
  grok: 'grok-cli',
  http: 'local',
  direct: 'local',
};

/**
 * 引擎的规范名，把别名（agy、http、direct 等）折叠进来。
 * 只查自有属性：别名表是个普通对象，裸下标会走原型链，于是 "constructor"
 * 解析成 Object 的构造函数、被当成真值，`config set constructor.apiKey`
 * 就把 key 写到了那个全局对象上，还打印了成功，实际上什么都没保存。
 */
export function canonicalEngineName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return Object.hasOwn(CANONICAL_ENGINE, trimmed) ? CANONICAL_ENGINE[trimmed] : trimmed;
}

/** 只认 JSON 解析出来的对象：null、数组以及原型链上的居民都不算设置。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LegacyConfig {
  /** v2：一个全局提供方名称。 */
  provider?: string;
  providers?: Record<string, EngineSettings>;
  /** v3.0-3.1：每个角色一个引擎。 */
  search?: LegacyRoleConfig;
  fetch?: LegacyRoleConfig;
  social?: LegacyRoleConfig;
}

/** 把 'true'/'false'（大小写任意）或真正的布尔值转成布尔值，其余一律返回 undefined。 */
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
 * 把配置文件读成当前的形状。这里始终会跑两项迁移，
 * 所以旧文件无需用户动手就能继续工作：
 *
 * - 别名的引擎键（agy、antigravity、grok、http、direct）折叠到各自的
 *   规范名，而在角色出现之前写下的配置（一个全局 `provider` 加一个 `providers`
 *   映射，或按角色的 search/fetch/social 段）会收敛为顶层的 `engine` 偏好。
 * - `allowPrivateNetwork` 从单引擎的字符串迁移到顶层布尔值。
 *   旧的 `engines.<name>.allowPrivateNetwork` 位置和旧的 `"true"`/
 *   `"false"` 字符串形式都会被读取，并提升到新的顶层键。
 */
/**
 * 原始文件携带过的每一个字符串 apiKey，包括被别名折叠挤掉的那些
 * （同一个引擎的两种别名拼法可能各带一把 key，合并时只保留一把）。
 * 被挤掉的 key 已不在配置对象里，却可能残留在其他字段的文本里，
 * 所以 config show 仍然必须知道要把它抹掉。以迁移后的配置对象为键：
 * 这从不改动 JSON 形状。
 */
const SEEN_API_KEYS = new WeakMap<ModsearchConfig, string[]>();

export function migrateLegacyConfig(raw: ModsearchConfig & LegacyConfig): ModsearchConfig {
  const hasLegacy = Boolean(raw.providers || raw.provider || raw.search || raw.fetch || raw.social);
  const seenApiKeys = new Set<string>();

  // 顶层的字符串形式（"true"/"false"）也在这里一并转换。
  let allowPrivateNetwork = coerceBoolean(
    (raw as { allowPrivateNetwork?: unknown }).allowPrivateNetwork,
  );

  // 按每个引擎合并，而不是按整个映射合并：以前在新的 `engines.tavily.model`
  // 旁边放旧的 `providers.tavily.apiKey`，会把那把 key 整个丢掉。退役的
  // 单引擎 allowPrivateNetwork 标志被提升到顶层。
  //
  // 故意使用 null 原型：条目名来自一个可以手工编辑的文件，而在普通对象字面量上
  // `engines["__proto__"] = {...}` 并不定义一个属性，它会**设置原型**。
  // 于是该条目在 Object.entries 和 JSON.stringify 里隐形（doctor 会把继承来的
  // 键报成存在，下一次写入又会悄悄把它丢掉），而点号访问却仍然看得到它。
  // 在 null 原型对象上，同一个名字只是一个普通的自有属性：可见、可序列化，
  // 并像任何未知引擎一样被审视。
  const engines: Record<string, EngineSettings> = Object.create(null);
  const fold = (source: Record<string, Record<string, unknown>> | undefined) => {
    if (!isPlainObject(source)) {
      return;
    }
    for (const [name, rawSettings] of Object.entries(source)) {
      // 手工编辑出来、并非对象的条目（字符串、数组）没有字段可合并；
      // 跳过它，而不是把它的字符合并进来。
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

  // 一个曾经只装着迁移标志的引擎条目现在是空的：删掉它，
  // 免得生效配置里出现一个空壳 `local: {}`。
  for (const [name, settings] of Object.entries(engines)) {
    if (Object.keys(settings).length === 0) {
      delete engines[name];
    }
  }

  // 任何旧形状都收敛为这个偏好：按角色的搜索引擎，或一个恰好是搜索引擎的
  // v2 全局提供方。当前形状的配置则原样保留它的 `engine`，空字符串也不例外。
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
  // 这个函数会依据一份已知键清单重建配置，所以新增的顶层段
  // 除非在这里被搬运过去，否则就会被丢掉。漏掉一个不会大声报错：
  // 读取路径只会报告默认值。
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
    // 只有文件缺失才意味着「没有配置」。其他任何情况（权限问题、本该是文件
    // 的位置放了个目录）都是值得点名的真问题，而不是悄悄降级到默认值。
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

/** 用户指定的引擎，如果有的话。 */
export function chosenEngine(config: ModsearchConfig): string | undefined {
  return config.engine?.trim() || undefined;
}

/** 配额冷却是否启用。默认开启，只有设为 'off' 时才关闭。 */
export function cooldownEnabled(config: ModsearchConfig): boolean {
  return config.cooldown?.trim().toLowerCase() !== 'off';
}

/** 是否允许保留地址与私有地址段。默认关闭。 */
export function allowsPrivateNetwork(config: ModsearchConfig): boolean {
  return config.allowPrivateNetwork === true;
}

/** 默认融合；`chain` 恢复一次一个引擎的旧行为。 */
export function aggregateMode(config: ModsearchConfig): AggregateMode {
  return config.aggregate?.mode === 'chain' ? 'chain' : 'rrf';
}

/** 一次融合运行的总墙钟预算，单位为毫秒。 */
export function aggregateDeadlineMs(config: ModsearchConfig): number {
  const configured = config.aggregate?.deadlineMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return 8_000;
}

/** 融合结果保持可缓存的时间。0 表示关闭缓存。 */
export function aggregateCacheTtlMs(config: ModsearchConfig): number {
  const configured = config.aggregate?.cacheTtlMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return 5 * 60 * 1000;
}

/**
 * 一个引擎如何把自己暴露出去。缺失的键采用在这些设置出现之前
 * 写下的配置本该得到的默认值。
 */
export function exposeOf(settings: EngineSettings): { aggregate: boolean; tool: boolean } {
  const expose = isPlainObject(settings.expose) ? settings.expose : {};
  return {
    aggregate: expose.aggregate !== false,
    tool: expose.tool === true,
  };
}

/** 单个引擎的设置，其中环境变量覆盖文件内容。 */
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
  // 一个「除非点名否则关闭」的引擎，只在文件没有表态时才采用该默认。
  // 有两样东西算作表态：这里显式给出的 enabled 值，以及它正是文件所钉住的
  // 首选引擎——钉住一个引擎然后又拒绝运行它，就是配置在自相矛盾。
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
 * 设置一个带点的键，并以 0600 权限落盘。两种形状：
 *   search.engine tavily             角色到引擎
 *   engines.tavily.apiKey <key>      引擎设置
 * 可以省略 `engines.` 前缀：`tavily.apiKey` 也能用。
 */
export function setConfigValue(
  dottedKey: string,
  value: string,
  configPath = currentConfigPath(),
): void {
  const config = loadConfigFile(configPath);
  const parts = dottedKey.split('.').filter(Boolean);

  // `engine <name>` 就是角色层面的全部接口。`search.engine` 仍然可用，
  // 免得旧形状形成的肌肉记忆撞上错误。非空值必须是真实存在的引擎名：
  // 路由器在手工编辑的文件里遇到拼写错误会带着警告容忍过去，但 CLI 没有理由
  // 制造这种错误，而 doctor 又会把错误值原样回显出来（其中还带着粘贴进来的
  // 秘密，这种文本宁可拒绝也不要显示）。空值则回到自动模式。
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
    // 文件是按精确的小写规范名回读的，所以一个未知或大小写不对的名字会被存进去、
    // 报成已保存，然后永远不再被读取。在这里拒绝，能把静默的数据丢失
    // 变成一个立刻可以发现、可以修复的错误。
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
    // 手工编辑的文件在这些位置可能放任何东西。拒绝展开一个非对象，
    // 而不是让写盘结果被弄脏。
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
      // 空值会取消这项覆盖，回到官方端点。其他任何值都必须是完整的源，
      // 在这里就拒绝，而不是留到搜索时变成一个让人困惑的抓取失败。
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
      // 空值会取消这项覆盖，回到跟随环境变量。存下的值要么是关键字、要么是 URL，
      // 绝不会是半成品：路由器每次运行都会解析它，所以这里存下一个它无法
      // 生效的值，等到出错时就离这条命令很远了。
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
 * 配置目录里存着密钥材料，所以按 0700 创建。已存在的目录保持它原有的权限模式：
 * 每次写入都重新收紧，会覆盖用户有意设置的权限，而目录里的文件自带 0600。
 * 在没有 POSIX 权限模式的平台上，chmod 尽力而为。
 */
function ensurePrivateDir(dir: string): void {
  if (fs.existsSync(dir)) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 在没有 chmod 的平台上尽力而为
  }
}

/**
 * 把密钥材料写成一个崭新的 0600 文件，再改名就位。
 * writeFileSync 的 mode 只在它**创建**文件时生效：重写一个已存在的 0644 配置，
 * 会让新 key 在 chmod 之前处于人人可读状态；而一个被别人预先放好的文件，
 * 会把内容收进对方的 inode，而 chmod 又会静默失败。同目录的临时文件天生就是
 * 0600，改名替换的是 inode，于是这两个窗口都不存在。
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
      // 改名失败才是值得报告的那个错误
    }
    throw error;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // 在没有 chmod 的平台上尽力而为
  }
}

function writeConfigFile(config: ModsearchConfig, configPath: string): void {
  writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * 起始文件只放形状，不放别的东西。预先填满每个引擎和每个默认值，
 * 看起来体贴、实则不是：它把真正的决策埋进了一堆占位符里，而且把今天的默认值
 * 写进文件就等于把它们冻结了，以后默认模型一改，就会被这份副本悄悄覆盖掉。
 */
export const CONFIG_TEMPLATE: ModsearchConfig = {
  // 空表示：使用本机可用的最佳引擎。
  engine: '',
  engines: {},
};

/** 写一个起始配置。除非设置了 force，否则拒绝覆盖已有文件。 */
export function initConfigFile(configPath = currentConfigPath(), force = false): void {
  if (!force && fs.existsSync(configPath)) {
    throw new Error(`${configPath} already exists. Use --force to overwrite.`);
  }
  writePrivateFile(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`);
}

/** 文件或环境里持有的每一把 API key，包括被别名折叠挤掉的牺牲者。 */
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
 * 把已知的每一把 key 从值树的所有字符串里抹掉，最长的 key 优先，
 * 免得互相重叠的较短 key 把较长的 key 切成还能复原的两半。
 * 完全不假设长度：配置层对 apiKey 不设下限，网关发多短的 key 就是多短，
 * 所以哪怕只有一个字符的 key，也要从它出现的每个字符串里抹掉。短 key 会把
 * 视图的可读性撕碎，而这正是正确的失败方式：这份输出是用来粘进 issue 的，
 * 撕碎的视图是安全的，而可读却泄露了凭据的视图不是。
 *
 * 仅限值，这是结构性约定：渲染视图里的每个属性名要么是编译期常量、
 * 要么是注册表里的引擎名，而用户数据（包括手写的引擎拼法）只存在于值里。
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
    // 已知 key 的拆抹不设长度下限，随后形状网（redactSecrets）再兜住那些
    // 没人声明为 key、但长得像令牌的字符串：粘在模型备注里的 sk- 凭据、
    // 网关 URL 里的 api_key= 参数。一个没有已知形状、又只住在非秘密字段里的
    // 秘密仍是无从得知的；安全文档也是这么写的。
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
 * 渲染生效配置：modsearch 实际会用什么，而不只是文件里写了什么。环境变量按
 * `engineSettings` 合并它们的方式合并进来，每个值都标注来源（`file` 或 `env`），
 * 别名的引擎键（agy、antigravity、grok、direct）显示在各自的规范名下，
 * API key 则始终保持遮掩。
 *
 * 脱敏在这里是一条边界，而不是逐字段的习惯：这份输出的产品契约就是
 * 「可以安全地粘进 issue」。key 在它自己的字段里被遮掩，在同一行的其他所有
 * 字段里被抹掉（以前一把粘进网关 URL 或模型备注里的 key，会在隔着它自己那个
 * 遮掩位的相邻字段里被完整打印出来），URL 里的凭据被遮掩，未知的引擎名变成
 * note 值而不是属性名，最后再对整个树里的每个字符串做一遍已知 key 的抹除。
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
      // 两者都可能在 userinfo 里携带凭据（`http://user:pass@host`），
      // 而这份输出是要能安全粘进 issue 的。
      text = maskUrlCredentials(text);
    }
    // 同行清洗：这一行自己的 key 不能存活在它的其他字段里。
    for (const entryKey of entryKeys) {
      text = text.split(entryKey).join('[redacted]');
    }
    return text;
  };

  // 先处理文件里的设置，别名的键折叠到各自的规范引擎。注册表不认识的引擎名
  // 永远不会变成属性名：手写的拼法是用户数据，而用户数据只存在于值里。
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

  // 环境变量覆盖，用的正是 engineSettings 应用的那套绑定。环境变量的值
  // 压过文件，所以它连来源标注也一并覆盖。
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
  // 最后一道防线：视图里的任何字符串都不许有已知 key 存活下来，
  // 无论它被粘进了哪个字段或哪条 note。
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
