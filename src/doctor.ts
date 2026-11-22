// `searchfuse doctor`：在本机诊断配置与路由，不消耗配额、不发起网络请求。
// 它只看 Node 版本、配置文件、环境变量、引擎二进制是否在 PATH 上、以及
// Grok 登录文件是否存在。它报告的一切都是本地事实，所以在任何机器上、
// 运行任意多次都是安全的。
import * as fs from 'fs';
import {
  aggregateDeadlineMs,
  aggregateMode,
  allowsPrivateNetwork,
  chosenEngine,
  cooldownEnabled,
  currentConfigPath,
  engineSettings,
  effectiveMcp,
  exposeOf,
  isPlainObject,
  loadConfigFile,
  type ModsearchConfig,
  type Role,
  ROLES,
} from './config.ts';
import {
  coolingEntry,
  currentStatePath,
  loadCooldownState,
  parseCooldownStateKey,
} from './cooldown.ts';
import { isServerNameValid } from './mcp/protocol.ts';
import { grokAuthFile } from './providers/grok.ts';
import {
  allEngines,
  enginesForRole,
  findEngine,
  ROLE_PREFERENCE,
  type SearchEngine,
} from './providers/index.ts';
import { commandOnPath } from './system.ts';
import { splitApiKeys } from './util/apiKeys.ts';

/** 这个构建承诺的 Node 版本下限。与 package.json 的 engines 字段保持一致。 */
export const MIN_NODE = '22.13.0';

export interface EngineDiagnosis {
  engine: string;
  /** 自动路由是否允许使用这个引擎。 */
  enabled: boolean;
  ready: boolean;
  /** 用一行解释就绪判定结果。 */
  reason: string;
  /** 尚未就绪时，一条可复制、能让它就绪的命令。 */
  fix?: string;
  /** 对于需要密钥的引擎：密钥来自何处，不存在时为 null。 */
  keySource?: 'env' | 'file' | null;
}

export interface RoleDiagnosis {
  role: Role;
  /** 平实的职责名称。 */
  job: string;
  /** 该角色的候选引擎，按解析顺序排列。 */
  candidates: EngineDiagnosis[];
  /** 第一个已启用且就绪的候选引擎，没有任何合格者时为 null。 */
  resolved: string | null;
}

/** 一个当前正在冷却的引擎，以及还剩多久。 */
export interface CooldownDiagnosis {
  engine: string;
  /** 按密钥冷却时使用的从零开始的 API 密钥索引。旧式引擎级冷却没有这个字段。 */
  keyIndex?: number;
  /** 可能恢复的 ISO 时间。 */
  until: string;
  /** 人类可读的剩余时间，例如 "1h 30m" 或 "45m"。 */
  remaining: string;
  reason: string;
}

export interface DoctorReport {
  node: { version: string; minimum: string; ok: boolean; fix?: string };
  engineChoice: {
    /** 配置的搜索引擎，自动选择时为 null。 */
    value: string | null;
    source: 'file' | 'default';
    /** 配置的名称不是已知引擎时设置。 */
    problem?: string;
  };
  configFile: {
    path: string;
    exists: boolean;
    /** 文件存在时的八进制权限字符串（例如 "600"）。 */
    mode?: string;
    /**
     * 在强制 POSIX 权限的平台上，文件可被同组或其他用户读取时为 false。
     * 文件不存在也算正常（true）：默认值不泄露任何东西。Windows 对每个文件
     * 都报 666/777，所以在那里跳过这项判定，而不是虚报狼来了。
     */
    permissionsOk: boolean;
    /** 权限过于开放时的修复建议。 */
    note?: string;
    readable: boolean;
    /** 文件存在但无法读取或解析时设置。 */
    problem?: string;
  };
  allowPrivateNetwork: { enabled: boolean; source: 'file' | 'default' };
  /** 配额冷却：开关状态，以及此刻正在冷却的每个引擎。 */
  cooldown: { enabled: boolean; statePath: string; engines: CooldownDiagnosis[] };
  /**
   * 融合搜索的静态配置。
   *
   * 这里只回答「配置会让它怎么跑」，不回答「它刚才跑成什么样」：后者属于
   * 那一次运行自己的 `uncertainty`，doctor 是另一个进程，看不到它。
   */
  aggregate: {
    /** 融合是否参与 web 路由。 */
    mode: 'rrf' | 'chain';
    /** 整轮运行的墙钟预算。 */
    deadlineMs: number;
    /** 会参与融合的引擎，以及为什么某些引擎不会。 */
    participants: Array<{ engine: string; reason: string }>;
  };
  /**
   * 配置文件里声明的 MCP 服务端。
   *
   * 与聚合一样，这一节是静态的：它说「配置声明了什么」，不说「刚才连上没有」。
   * 真实的连接结果写在插件日志里，因为那需要一个正在运行的宿主。
   */
  mcp: {
    servers: Array<{
      key: string;
      url: string | null;
      enabled: boolean;
      /** 键名不合契约时设置：这个键会成为工具名的一部分。 */
      problem?: string;
    }>;
  };
  roles: RoleDiagnosis[];
}

export interface DoctorOptions {
  config?: ModsearchConfig;
  env?: NodeJS.ProcessEnv;
  /** 默认取运行中的 Node 版本。可注入以便测试。 */
  nodeVersion?: string;
  configPath?: string;
  /** 冷却状态文件。可注入以便测试。 */
  statePath?: string;
  /** 用于计算剩余时间的时钟。可注入以便测试。 */
  now?: Date;
}

const ROLE_JOB: Record<Role, string> = {
  search: 'search the web',
  fetch: 'fetch a page',
  social: 'search X',
};

const INSTALL_AGY = 'curl -fsSL https://antigravity.google/cli/install.sh | bash && agy';
const INSTALL_GROK = 'curl -fsSL https://x.ai/cli/install.sh | bash && grok';

function configuredApiKeys(
  fromEnv: string | undefined,
  fromFile: string | undefined,
): { count: number; source: 'env' | 'file' | null } {
  const envKeys = splitApiKeys(fromEnv);
  if (envKeys.length > 0) {
    return { count: envKeys.length, source: 'env' };
  }
  const fileKeys = splitApiKeys(fromFile);
  return { count: fileKeys.length, source: fileKeys.length > 0 ? 'file' : null };
}

function apiKeyPresentReason(count: number, source: 'env' | 'file'): string {
  return `API key present (${count} ${count === 1 ? 'key' : 'keys'}, from ${source})`;
}

/** 比较两个点分数字版本号。返回负数、零或正数。 */
function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** 诊断单个引擎：它在本机能否使用，不能的话怎么修。 */
function diagnoseEngine(
  engine: SearchEngine,
  config: ModsearchConfig,
  env: NodeJS.ProcessEnv,
  role: Role,
): EngineDiagnosis {
  const settings = engineSettings(engine.name, config, env);
  const enabled = settings.enabled !== false;

  if (engine.name === 'antigravity-cli') {
    const bin = settings.bin || 'agy';
    const ready = commandOnPath(bin, env);
    return {
      engine: engine.name,
      enabled,
      ready,
      reason: ready
        ? `binary "${bin}" found and runnable`
        : `binary "${bin}" not found on PATH (sign-in also required, once)`,
      ...(ready ? {} : { fix: INSTALL_AGY }),
    };
  }

  if (engine.name === 'tavily') {
    const { count, source: keySource } = configuredApiKeys(
      env.TAVILY_API_KEY,
      config.engines?.tavily?.apiKey,
    );
    const ready = count > 0;
    return {
      engine: engine.name,
      enabled,
      ready,
      keySource,
      reason: keySource
        ? apiKeyPresentReason(count, keySource)
        : 'no API key (not in TAVILY_API_KEY or the config file)',
      ...(ready ? {} : { fix: 'searchfuse config set tavily.apiKey <key>' }),
    };
  }

  if (engine.name === 'exa') {
    const { count, source: keySource } = configuredApiKeys(
      env.EXA_API_KEY,
      config.engines?.exa?.apiKey,
    );
    const ready = count > 0;
    return {
      engine: engine.name,
      enabled,
      ready,
      keySource,
      reason: keySource
        ? apiKeyPresentReason(count, keySource)
        : 'no API key (not in EXA_API_KEY or the config file)',
      ...(ready ? {} : { fix: 'searchfuse config set exa.apiKey <key>' }),
    };
  }

  if (engine.name === 'keenable') {
    const { count, source: keySource } = configuredApiKeys(
      env.KEENABLE_API_KEY,
      config.engines?.keenable?.apiKey,
    );
    return {
      engine: engine.name,
      enabled,
      ready: true,
      keySource,
      reason: keySource
        ? apiKeyPresentReason(count, keySource)
        : 'keyless: works with no key and no signup (1,000 requests/hour, shared by everyone on this IP). Set a free key for 100,000 requests/month of your own.',
    };
  }

  if (engine.name === 'youcom') {
    return {
      engine: engine.name,
      enabled,
      ready: true,
      reason:
        'keyless: works with no key and no signup (100 searches/day, shared by everyone on this IP).',
    };
  }

  if (engine.name === 'firecrawl') {
    const { count, source: keySource } = configuredApiKeys(
      env.FIRECRAWL_API_KEY,
      config.engines?.firecrawl?.apiKey,
    );
    const configuredEngine = chosenEngine(config);
    // 免密钥抓取默认开启；只有显式 `keylessFetch: false` 才会关闭，而显式
    // 选择 Firecrawl 作为引擎可以覆盖它（选择引擎本身就是同意）。这里与
    // firecrawlProvider 以及路由器无条件加入已配置引擎的行为保持一致。
    const keylessFetch =
      settings.keylessFetch === undefined ||
      settings.keylessFetch === true ||
      (configuredEngine !== undefined && findEngine(configuredEngine)?.name === 'firecrawl');
    if (role === 'search') {
      return {
        engine: engine.name,
        enabled,
        ready: true,
        keySource,
        reason: keySource
          ? apiKeyPresentReason(count, keySource)
          : 'keyless: works with no key and no signup (Firecrawl grants 1,000 free credits/month, metered per IP per day). Set a free key for your own quota.',
      };
    }
    const ready = Boolean(keySource || keylessFetch);
    return {
      engine: engine.name,
      enabled,
      ready,
      keySource,
      reason: keySource
        ? apiKeyPresentReason(count, keySource)
        : keylessFetch
          ? 'keyless fetch (default): public pages are read by a cloud browser, no key or signup needed. Opt out with: searchfuse config set firecrawl.keylessFetch false'
          : 'keyless fetch is switched off (firecrawl.keylessFetch false), so Firecrawl is excluded from automatic page fetch.',
      ...(ready ? {} : { fix: 'searchfuse config set firecrawl.keylessFetch true' }),
    };
  }

  if (engine.name === 'grok-cli') {
    const bin = settings.bin || 'grok';
    const binPresent = commandOnPath(bin, env);
    const authPath = grokAuthFile();
    const authPresent = fs.existsSync(authPath);
    const ready = binPresent && authPresent;
    const parts: string[] = [];
    parts.push(binPresent ? `binary "${bin}" found` : `binary "${bin}" not found on PATH`);
    parts.push(authPresent ? `login file ${authPath} present` : `login file ${authPath} missing`);
    return {
      engine: engine.name,
      enabled,
      ready,
      reason: parts.join('; '),
      ...(ready ? {} : { fix: INSTALL_GROK }),
    };
  }

  // 本地引擎以及其他一切无需配置的东西。
  const ready = engine.isAvailable(settings, env, role);
  return {
    engine: engine.name,
    enabled,
    ready,
    reason: ready ? 'built in, needs nothing installed' : engine.requirement,
  };
}

/** 某角色的候选引擎，按解析顺序排列，并已去重。 */
function candidatesForRole(role: Role, config: ModsearchConfig): SearchEngine[] {
  const names: string[] = [];
  const configured = chosenEngine(config);
  if (configured) {
    const engine = findEngine(configured);
    if (engine && engine.roles.includes(role)) {
      names.push(engine.name);
    }
  }
  for (const name of ROLE_PREFERENCE[role]) {
    names.push(name);
  }
  // 能服务这个角色但不在默认链路里的引擎同样会得到诊断。antigravity-cli 就是
  // 其中之一：它靠合成生成、要花上一分钟以上，所以被排除在自动路由之外，但
  //「agy 二进制装没装、登没登录」恰恰是 doctor 存在的意义要回答的问题。没有
  // 这段，用户仍可用 --engine 强制的引擎会从报告里悄悄消失。
  for (const engine of enginesForRole(role)) {
    if (!names.includes(engine.name)) {
      names.push(engine.name);
    }
  }

  const seen = new Set<string>();
  const engines: SearchEngine[] = [];
  for (const name of names) {
    const engine = findEngine(name);
    if (engine && !seen.has(engine.name)) {
      seen.add(engine.name);
      engines.push(engine);
    }
  }
  return engines;
}

/** 此刻正在冷却的引擎，以及开关本身是否打开。 */
function diagnoseCooldown(
  config: ModsearchConfig,
  statePath: string,
  now: Date,
): DoctorReport['cooldown'] {
  if (!cooldownEnabled(config)) {
    return { enabled: false, statePath, engines: [] };
  }
  const state = loadCooldownState(statePath);
  const engines: CooldownDiagnosis[] = [];
  for (const stateKey of Object.keys(state.engineCooldowns)) {
    const target = parseCooldownStateKey(stateKey);
    const entry = coolingEntry(state, target.engine, now, target.keyIndex);
    if (entry) {
      engines.push({
        engine: target.engine,
        ...(target.keyIndex === undefined ? {} : { keyIndex: target.keyIndex }),
        until: entry.until,
        remaining: formatRemaining(Date.parse(entry.until) - now.getTime()),
        reason: entry.reason.split('\n')[0].slice(0, 120),
      });
    }
  }
  engines.sort(
    (a, b) => a.engine.localeCompare(b.engine) || (a.keyIndex ?? -1) - (b.keyIndex ?? -1),
  );
  return { enabled: true, statePath, engines };
}

function formatRemaining(ms: number): string {
  if (ms <= 0) {
    return '0m';
  }
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const configPath = options.configPath ?? currentConfigPath();
  const statePath = options.statePath ?? currentStatePath();
  const now = options.now ?? new Date();

  // 读取配置，但绝不让损坏的文件中断诊断：损坏的文件本身就是 doctor
  // 存在要指出来的东西之一。
  let config: ModsearchConfig = options.config ?? {};
  let configProblem: string | undefined;
  const exists = fs.existsSync(configPath);
  let readable = !exists ? false : true;
  let mode: string | undefined;
  let permissionsOk = true;
  if (options.config === undefined && exists) {
    // 先查权限，再解析：损坏的文件里照样有密钥，所以一份无法解析的 0644
    // 配置仍必须拿到 chmod 的判定结论。
    try {
      const stat = fs.statSync(configPath);
      const bits = stat.mode & 0o777;
      mode = bits.toString(8).padStart(3, '0');
      // 要判定，而不只是报告：文件里存着 API 密钥。Windows 对每个文件都
      // 回读 666/777，所以只有具备真实 POSIX 权限的平台（存在
      // process.getuid）才给出判定。
      const enforcesPosixPerms = typeof process.getuid === 'function';
      permissionsOk = !enforcesPosixPerms || (bits & 0o077) === 0;
    } catch {
      // stat 失败会通过下面的读取路径报告
    }
    try {
      config = loadConfigFile(configPath);
    } catch (error) {
      readable = false;
      configProblem = error instanceof Error ? error.message : String(error);
    }
  } else if (options.config === undefined) {
    readable = false; // 没有文件不算「可读」，只意味着用默认值
  }

  const ok = compareVersions(nodeVersion, MIN_NODE) >= 0;

  const configuredName = chosenEngine(config);
  let engineProblem: string | undefined;
  if (configuredName && !findEngine(configuredName)) {
    engineProblem = `"${configuredName}" is not a known engine, so search picks one automatically`;
  }

  const roles: RoleDiagnosis[] = ROLES.map((role) => {
    const candidates = candidatesForRole(role, config).map((engine) =>
      diagnoseEngine(engine, config, env, role),
    );
    const resolved = candidates.find((c) => c.enabled && c.ready)?.engine ?? null;
    return { role, job: ROLE_JOB[role], candidates, resolved };
  });

  const allowPrivate = allowsPrivateNetwork(config);

  return {
    node: {
      version: nodeVersion,
      minimum: MIN_NODE,
      ok,
      ...(ok ? {} : { fix: `Upgrade Node to ${MIN_NODE} or newer.` }),
    },
    engineChoice: {
      value: configuredName ?? null,
      source: configuredName ? 'file' : 'default',
      ...(engineProblem ? { problem: engineProblem } : {}),
    },
    configFile: {
      path: configPath,
      exists,
      ...(mode ? { mode } : {}),
      permissionsOk,
      ...(permissionsOk
        ? {}
        : { note: `group/world can read this file. Run: chmod 600 ${configPath}` }),
      readable,
      ...(configProblem ? { problem: configProblem } : {}),
    },
    allowPrivateNetwork: {
      enabled: allowPrivate,
      source: allowPrivate ? 'file' : 'default',
    },
    cooldown: diagnoseCooldown(config, statePath, now),
    aggregate: diagnoseAggregate(config, env),
    mcp: diagnoseMcp(config),
    roles,
  };
}

/**
 * 融合搜索会怎么跑。
 *
 * 每个搜索引擎都列出来，并说明它参与还是不参与——以及为什么。用户跑 doctor
 * 想知道「为什么这个引擎没被用上」，只列参与者回答不了这个问题，而「没被用上」
 * 在语义上有四种完全不同的成因：被关掉、只做独立工具、本机不可用、正在冷却。
 * 这里能回答前三种；冷却属于运行时状态，由 cooldown 那一节负责。
 */
function diagnoseAggregate(
  config: ModsearchConfig,
  env: NodeJS.ProcessEnv,
): DoctorReport['aggregate'] {
  const participants: Array<{ engine: string; reason: string }> = [];
  for (const engine of allEngines()) {
    if (!engine.roles.includes('search')) {
      continue;
    }
    const settings = engineSettings(engine.name, config, env);
    if (settings.enabled === false) {
      participants.push({ engine: engine.name, reason: '关闭（enabled: false）' });
      continue;
    }
    if (!exposeOf(settings).aggregate) {
      participants.push({ engine: engine.name, reason: '不参与融合（expose.aggregate: false）' });
      continue;
    }
    if (engine.execute === undefined) {
      // 子进程引擎不从这条路径跑；说清这一点，免得读者以为它坏了。
      participants.push({ engine: engine.name, reason: '进程内引擎之外（走链式路径）' });
      continue;
    }
    if (!engine.isAvailable(settings, env, 'search')) {
      participants.push({ engine: engine.name, reason: '本机不可用（缺少密钥或命令）' });
      continue;
    }
    participants.push({ engine: engine.name, reason: '参与融合' });
  }
  return {
    mode: aggregateMode(config),
    deadlineMs: aggregateDeadlineMs(config),
    participants,
  };
}

/**
 * 配置文件里声明了哪些 MCP 服务端。
 *
 * 只说配置，不说连接结果：真实连接发生在宿主进程里，而 doctor 是另一个进程，
 * 看不到那份 session。把两者混在一起会让一节「配置对不对」的诊断看起来像是在
 * 回答「刚才连上没有」，而它做不到后者。键名契约在配置阶段就能判——它将成为
 * 工具名的一部分，所以一个不合法的键等于一个永远注册不上的工具。
 */
function diagnoseMcp(config: ModsearchConfig): DoctorReport['mcp'] {
  // 用 effectiveMcp 而不是直接读 config.mcp：默认集合（context7/grep）
  // 是代码里的常量，doctor 必须看到它们，否则会报告「没有 MCP」而实际
  // 三个宿主都会注册。
  const servers: Record<string, unknown> = effectiveMcp(config);
  const out: DoctorReport['mcp']['servers'] = [];
  for (const [key, raw] of Object.entries(servers)) {
    if (!isPlainObject(raw)) {
      out.push({ key, url: null, enabled: false, problem: '条目不是一个对象' });
      continue;
    }
    const entry: DoctorReport['mcp']['servers'][number] = {
      key,
      url: typeof raw.url === 'string' ? raw.url : null,
      enabled: raw.enabled !== false,
    };
    if (!isServerNameValid(key)) {
      entry.problem = '键名必须匹配 [A-Za-z0-9_-]{1,32}（它会成为工具名的一部分）';
    } else if (entry.url === null) {
      entry.problem = '缺少 url';
    }
    out.push(entry);
  }
  return { servers: out };
}

/** 人类可读的报告。`--json` 则直接打印对象。 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['searchfuse doctor', ''];

  lines.push('Node');
  lines.push(`  version: ${report.node.version}`);
  lines.push(`  minimum: ${report.node.minimum}`);
  lines.push(`  status:  ${report.node.ok ? 'OK' : 'TOO OLD'}`);
  if (report.node.fix) {
    lines.push(`  fix:     ${report.node.fix}`);
  }
  lines.push('');

  lines.push('Config');
  const choice = report.engineChoice;
  lines.push(
    `  search engine: ${choice.value ? `${choice.value} (from config file)` : '(unset: automatic)'}`,
  );
  if (choice.problem) {
    lines.push(`    ! ${choice.problem}`);
  }
  const file = report.configFile;
  if (!file.exists) {
    lines.push(`  file: ${file.path} (not present, running on defaults)`);
  } else if (file.problem) {
    lines.push(`  file: ${file.path} (unreadable)`);
    lines.push(`    ! ${file.problem}`);
  } else {
    lines.push(`  file: ${file.path} (present, mode ${file.mode})`);
    if (!file.permissionsOk && file.note) {
      lines.push(`    ! ${file.note}`);
    }
  }
  lines.push(
    `  allowPrivateNetwork: ${report.allowPrivateNetwork.enabled ? 'on' : 'off'} (${report.allowPrivateNetwork.source})`,
  );
  lines.push('');

  lines.push('Cooldown');
  if (!report.cooldown.enabled) {
    lines.push('  switch: off (state not consulted)');
  } else if (report.cooldown.engines.length === 0) {
    lines.push('  switch: on');
    lines.push('  no engines are cooling right now');
  } else {
    lines.push('  switch: on');
    for (const c of report.cooldown.engines) {
      const label = c.keyIndex === undefined ? c.engine : `${c.engine} key ${c.keyIndex + 1}`;
      lines.push(`  - ${label.padEnd(16)} cooling, ${c.remaining} left (until ${c.until})`);
      if (c.reason) {
        lines.push(`      reason: ${c.reason}`);
      }
    }
  }
  lines.push('');

  lines.push('Aggregate');
  const agg = report.aggregate;
  lines.push(`  mode:     ${agg.mode === 'rrf' ? 'rrf (concurrent fanout, fused)' : 'chain (sequential fallback)'}`);
  lines.push(`  deadline: ${agg.deadlineMs} ms (whole run)`);
  for (const p of agg.participants) {
    const mark = p.reason === '参与融合' ? 'FUSED  ' : 'skip   ';
    lines.push(`  - ${p.engine.padEnd(16)} ${mark}  ${p.reason}`);
  }
  lines.push('');

  lines.push('MCP');
  if (report.mcp.servers.length === 0) {
    lines.push('  no servers configured');
  } else {
    for (const server of report.mcp.servers) {
      const state = !server.enabled ? 'off    ' : server.problem ? 'INVALID' : 'on     ';
      lines.push(`  - ${server.key.padEnd(16)} ${state}  ${server.url ?? '(no url)'}`);
      if (server.problem) {
        lines.push(`      ! ${server.problem}`);
      }
    }
    // 这一节只读配置。真实连接结果写在插件日志里，说清楚免得读者误以为
    // 「这里没报警告」等于「刚才连上了」。
    lines.push('  note: these are config facts only; live connection results appear in the plugin log');
  }
  lines.push('');

  for (const role of report.roles) {
    lines.push(`${role.role} (${role.job})`);
    lines.push(`  resolved: ${role.resolved ?? '(none available)'}`);
    for (const c of role.candidates) {
      const mark = !c.enabled ? 'disabled' : c.ready ? 'READY  ' : 'not set';
      lines.push(`  - ${c.engine.padEnd(16)} ${mark}  ${c.reason}`);
      if (c.enabled && !c.ready && c.fix) {
        lines.push(`      fix: ${c.fix}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
