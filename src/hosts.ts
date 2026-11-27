// 把 searchfuse 接入各家宿主：写它们的配置文件、装它们的扩展。
//
// 为什么是行级编辑而不是引入一个 YAML 库：要改的东西只有三个键，而
// omp 的 config.yml 是用户手写的文件，里面有注释、有他自己的段序。解析
// 再序列化会重排格式、丢注释，哪怕库号称保留——那是 671K 依赖换来的
// 副作用。行级编辑只动需要动的那几行，其余一个字节都不碰。
//
// 所有写入都遵循同一条规则：**先备份，只改自己的键，其余原样保留**。
// 这不是谦虚，是因为这些文件不归我们所有。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** omp 的配置文件位置。官方文档：用户级是 `~/.omp/agent/config.yml`。 */
export function ompConfigPath(): string {
  return path.join(os.homedir(), '.omp', 'agent', 'config.yml');
}

/** omp 的扩展目录。它从此处自动发现 `.ts` / `.js`。 */
export function ompExtensionsDir(): string {
  return path.join(os.homedir(), '.omp', 'agent', 'extensions');
}

/**
 * 在 YAML 文本里把 `section.key` 设成某个标量值。
 *
 * 规则：
 * - 段不存在 → 在文件末尾新增段
 * - 段存在、键不存在 → 插到段内最后一个子键之后（保持缩进）
 * - 段存在、键存在 → 原地替换那一行的值
 * - 值为 `undefined` → 把那一行删掉（用于 disable）
 *
 * 只识别两空格缩进的子键，与 omp 自己的写法一致。这不是通用 YAML
 * 处理器，只服务我们关心的那三个键。
 */
export function setYamlScalar(text: string, section: string, key: string, value: string | undefined): string {
  const lines = text.split(/\r?\n/);
  // 末尾的空串是 split 的产物，最后写回时再补。先摘掉以免打乱行号。
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingEmpty) lines.pop();

  const sectionStart = lines.findIndex((line) => new RegExp(`^${section}:\\s*$`).test(line));
  const childPattern = /^\s{2}[^\s#][^:]*:/;

  if (sectionStart === -1) {
    // 段不存在：整段追加。disable 时无事可做。
    if (value === undefined) return text;
    lines.push(`${section}:`, `  ${key}: ${value}`);
    return `${lines.join('\n')}${trailingEmpty ? '\n' : ''}`;
  }

  // 段的结束：下一个顶格（非空、非注释、非缩进）行。
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0 || line.startsWith('#') || /^\s/.test(line)) continue;
    sectionEnd = i;
    break;
  }

  // 段内找这个键。
  const keyLine = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && new RegExp(`^\\s{2}${key}:`).test(line),
  );

  if (keyLine !== -1) {
    if (value === undefined) {
      lines.splice(keyLine, 1);
    } else {
      lines[keyLine] = `  ${key}: ${value}`;
    }
    return `${lines.join('\n')}${trailingEmpty ? '\n' : ''}`;
  }

  if (value === undefined) {
    // 键本来就不存在，disable 无需改动。
    return text;
  }

  // 键不存在：插到段内最后一个子键之后，保持缩进。
  let insertAt = sectionStart + 1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (childPattern.test(lines[i]!)) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `  ${key}: ${value}`);
  return `${lines.join('\n')}${trailingEmpty ? '\n' : ''}`;
}

/**
 * 写文件前先备份，并把「要不要写」与「备份在哪」一起返回。
 *
 * 为什么不返回 `string | undefined`：那样调用方分不清两种 `undefined`——
 * 「内容没变，不用写」和「文件是空的，没有东西可备份但要写」。这个歧义
 * 曾让空文件场景静默不写。
 */
interface WriteDecision {
  /** 内容是否与磁盘上不同（空文件也算不同）。 */
  changed: boolean;
  /** 备份文件路径；原文件为空或不存在时为 undefined。 */
  backup?: string;
}

function decideWrite(file: string, next: string): WriteDecision {
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, 'utf-8');
  } catch {
    // 文件不存在：没有东西要备份。
    current = undefined;
  }
  if (current === next) return { changed: false };

  if (current !== undefined && current !== '') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
    return { changed: true, backup };
  }
  return { changed: true };
}

/** 读 omp 配置；不存在时返回空串。 */
function readOmpConfig(file = ompConfigPath()): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/** omp 接入时需要写的三个键，以及值与它们的来源。 */
export interface OmpWiring {
  endpoint: string;
  token: string;
  /** `web/searxng` 或 `web/public`（disable 时）。 */
  webRole: string | undefined;
}

/**
 * 把 omp 接上或断开。
 *
 * 开启：写 `searxng.endpoint`、`searxng.token`、`modelRoles.web`，并清掉
 * Basic 凭据（omp 里 Basic 优先于 Bearer，留着会让 token 被忽略）。
 *
 * 关闭：清掉 `searxng.endpoint`、`searxng.token`、Basic 凭据，并把
 * `modelRoles.web` 写回 `web/public`——omp 没有任何运行时开关，不改写
 * 就等于 `hosts.omp.enabled = false` 不起作用。
 */
export function syncOmp(wiring: OmpWiring | undefined, file = ompConfigPath()): {
  changed: boolean;
  backup?: string;
} {
  let text = readOmpConfig(file);

  if (wiring === undefined) {
    // 断开：清掉接入时写的全部键。
    text = setYamlScalar(text, 'searxng', 'endpoint', undefined);
    text = setYamlScalar(text, 'searxng', 'token', undefined);
    text = setYamlScalar(text, 'searxng', 'basicUsername', undefined);
    text = setYamlScalar(text, 'searxng', 'basicPassword', undefined);
    text = setYamlScalar(text, 'modelRoles', 'web', 'web/public');
  } else {
    text = setYamlScalar(text, 'searxng', 'endpoint', wiring.endpoint);
    text = setYamlScalar(text, 'searxng', 'token', wiring.token);
    // Basic 优先于 Bearer，不清掉它 token 就被忽略，服务端回 401。
    text = setYamlScalar(text, 'searxng', 'basicUsername', undefined);
    text = setYamlScalar(text, 'searxng', 'basicPassword', undefined);
    text = setYamlScalar(text, 'modelRoles', 'web', wiring.webRole ?? 'web/searxng');
  }

  const decision = decideWrite(file, text);
  if (!decision.changed) {
    return { changed: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
  return decision.backup === undefined ? { changed: true } : { changed: true, backup: decision.backup };
}

/**
 * 装 omp 扩展：把模板里的绝对路径替换掉，写到 omp 的扩展目录。
 *
 * 为什么是渲染而不是复制：扩展被复制到 `~/.omp/agent/extensions/` 之后，
 * 它与本包的 `dist/` 已无相对关系，必须把绝对路径写进去才能拉起 kernel。
 *
 * `kernelPath` 用 kernel.js 而不是 serve.js：三家共享同一个聚合入口，
 * 而 omp 侧靠扩展 spawn 它——不走 HTTP，于是随机端口不再是个问题。
 */
export function installOmpExtension(source: string, kernelPath: string): string {
  // Windows 路径里有反斜杠：直接拼进单引号字符串会让 `\n` 变成真的换行。
  // 先转义成 JSON 字符串再剥掉外层引号，得到一段可安全嵌进源码的字面量。
  const escaped = JSON.stringify(kernelPath).slice(1, -1);
  const rendered = source.replaceAll('__SEARCHFUSE_KERNEL_PATH__', escaped);
  const dir = ompExtensionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'searchfuse.ts');
  fs.writeFileSync(target, rendered, 'utf-8');
  return target;
}

/**
 * 卸载 omp 扩展：删掉 `hosts sync` 装进去的那一个文件。
 *
 * 为什么需要它：`hosts.omp.enabled = false` 若只写配置而不动扩展，omp
 * 每次启动仍会加载扩展、仍会接管搜索——开关写着「关」，行为却是「开」。
 * 只删我们自己的文件，别的扩展一个都不碰；返回是否真的删掉了。
 */
export function removeOmpExtension(): boolean {
  const target = path.join(ompExtensionsDir(), 'searchfuse.ts');
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    // 文件本来就不在：没有东西可删，对调用方是「已关闭」的结果。
    return false;
  }
}

/**
 * 把 `searchfuseHosts` 镜像进 Claude Code 的 settings。
 *
 * 宿主二进制明确「插件不得写 settings 文件，只能 `$.settings.read`」，
 * 所以镜像必须由插件之外的 CLI 完成。
 *
 * 写入粒度：**只改 `searchfuseHosts` 这一个键**，其余原样保留。整份
 * `JSON.stringify` 回写会抹掉用户的 `permissions` / `hooks` /
 * `enabledPlugins`——备份只保住可恢复性，不保正确性。
 */
/** `hosts sync` 写进 Claude settings 的两条路径。 */
export interface ClaudePaths {
  /** `~/.searchfuse/runtime.json` 的绝对路径；服务不在时读它拿端口。 */
  runtimePath: string;
  /** `dist/kernel.js` 的绝对路径；服务不在时用它跑子进程。 */
  kernelPath: string;
  /**
   * 服务身份与候选端口。
   *
   * 为什么要写进来而不是让 mod 自己算：mod 的沙箱里既没有 `process` 也没有
   * `crypto`（实测），算不出 sha256 指纹。把结果预先写进 settings，mod 只需
   * 按候选顺序探 `/identity` 并比对指纹——与另外两端同一套判定。
   *
   * runtime.json 会在服务被 kill 时消失（close 跑不到），这一层是它消失后
   * 唯一还能找到服务的路。
   */
  identity?: { fingerprint: string; ports: number[] };
}

export function syncClaudeSettings(
  enabled: boolean,
  paths: ClaudePaths,
  file = claudeSettingsPath(),
): {
  changed: boolean;
  backup?: string;
} {
  let raw: Record<string, unknown> = {};
  let original = '';
  try {
    original = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(original);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在或不是合法 JSON：从空对象开始，但**不覆盖**坏文件之外的东西。
    if (original !== '') {
      // 原文件存在却解析不了：这是用户的配置，不能当作空的重写。
      throw new Error(`Cannot parse ${file}; refusing to overwrite it. Fix or delete the file first.`);
    }
  }

  const hosts = raw.searchfuseHosts;
  const existing =
    typeof hosts === 'object' && hosts !== null && !Array.isArray(hosts)
      ? (hosts as Record<string, unknown>)
      : {};
  const claude =
    typeof existing.claudeCode === 'object' && existing.claudeCode !== null
      ? (existing.claudeCode as Record<string, unknown>)
      : {};
  // 早退判据不能只看 enabled。升级前写下的 settings 只有 enabled/runtimePath/
  // kernelPath，没有 fingerprint 与 ports；只看 enabled === enabled 就会早退，
  // 于是新字段永远写不进去，claude 端的候选探测永远拿不到数据——它退化成
  // 「只能读 runtime.json」，而这次改造要解决的正是那个文件会消失。
  //
  // 所以凡是「本次要写的字段里有任何一个与现状不同」就重写。
  const nextClaude = {
    ...claude,
    enabled,
    runtimePath: paths.runtimePath,
    kernelPath: paths.kernelPath,
    ...(paths.identity === undefined
      ? {}
      : { fingerprint: paths.identity.fingerprint, ports: paths.identity.ports }),
  };
  const unchanged =
    claude.enabled === nextClaude.enabled &&
    claude.runtimePath === nextClaude.runtimePath &&
    claude.kernelPath === nextClaude.kernelPath &&
    JSON.stringify(claude.fingerprint) === JSON.stringify(nextClaude.fingerprint) &&
    JSON.stringify(claude.ports) === JSON.stringify(nextClaude.ports);
  if (unchanged) {
    return { changed: false };
  }

  // 一并写入两条绝对路径。mod 的沙箱里 `~` 不展开、`HOME` 读不到（实测），
  // 所以路径必须由插件之外的 CLI 写进来。
  raw.searchfuseHosts = {
    ...existing,
    claudeCode: nextClaude,
  };
  const next = `${JSON.stringify(raw, null, 2)}\n`;

  const decision = decideWrite(file, next);
  if (!decision.changed) return { changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf-8');
  return decision.backup === undefined ? { changed: true } : { changed: true, backup: decision.backup };
}

/** Claude Code 的用户级 settings。 */
export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Claude Code mod 的用户级安装目录。
 *
 * `~/.claude/skills/<name>/` 会被当成 `@skills-dir` 插件自动加载，每个会话
 * 生效，不需要 `--plugin-dir`。这是让「替换原生 WebSearch」常驻的唯一路径
 * ——`--plugin-dir` 只活在带这个 flag 的那一次会话里。
 */
export function claudeSkillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'searchfuse-mod');
}

/** mod 需要落地的文件，相对 `claude/` 源目录。顺序无关，只为打印好看。 */
const CLAUDE_MOD_FILES = [
  'SKILL.md',
  path.join('.claude-plugin', 'plugin.json'),
  path.join('hooks', 'hooks.json'),
  path.join('hooks', 'register.ts'),
  'tsconfig.json',
] as const;

/**
 * 把仓库里的 `claude/` 同步到 `~/.claude/skills/searchfuse-mod/`。
 *
 * 为什么需要它：那份常驻安装是**副本**，不是软链。手工拷一次之后，仓库里
 * `register.ts` 再改，技能目录那份不会跟着变——于是出现「代码已修、行为还是
 * 旧的」，与 pnpm `file:` 依赖被复制成快照是同一类陷阱。让它由 `hosts sync`
 * 管，改完源码跑一次就对齐。
 *
 * 写入粒度是**逐个文件**，不是整目录覆盖：技能目录里可能有用户自己加的
 * 东西，整目录替换会把它们抹掉。内容相同的文件不重写，保持 mtime 不变。
 *
 * `enabled=false` 时**不删目录**，这与 omp 的处理不同，理由要看清：
 * omp 没有任何运行时开关，留着扩展就仍在接管搜索，所以必须删；而 Claude
 * 的 `register.ts` 每次 `tool.call` 都读 `searchfuseHosts.claudeCode.enabled`，
 * 读到 false 就 `next(e)` 交回原生实现。删目录反而会让重新开启时静默失效
 * （文件没了，开关写 true 也没人加载）。
 */
export function installClaudeSkill(
  sourceDir: string,
  targetDir = claudeSkillDir(),
): { changed: boolean; installed: string[] } {
  const installed: string[] = [];
  for (const relative of CLAUDE_MOD_FILES) {
    const from = path.join(sourceDir, relative);
    const to = path.join(targetDir, relative);
    let content: string;
    try {
      content = fs.readFileSync(from, 'utf-8');
    } catch {
      // 源文件缺失：跳过这一个，其余照装。发布包里 `claude/` 未必齐全，
      // 一个文件缺失不该让整条 sync 失败。
      continue;
    }
    let current: string | undefined;
    try {
      current = fs.readFileSync(to, 'utf-8');
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content, 'utf-8');
    installed.push(relative);
  }
  return { changed: installed.length > 0, installed };
}

/** omp 的 MCP 配置文件。它从这里读，也兼容 `.mcp.json`。 */
export function ompMcpPath(): string {
  return path.join(os.homedir(), '.omp', 'agent', 'mcp.json');
}

/** MCP server 的配置形状，按 omp 的 `mcp.json` 来说。 */
interface McpServerEntry {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** 把 searchfuse 配置里的 `mcp` 段翻译成 omp 的 server 形状。 */
function toOmpServer(config: Record<string, unknown>): McpServerEntry | undefined {
  const transport = typeof config.transport === 'string' ? config.transport : undefined;
  const url = typeof config.url === 'string' ? config.url : undefined;
  if (transport === 'stdio' && typeof config.command === 'string') {
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    return args.length > 0
      ? { type: 'stdio', command: config.command, args }
      : { type: 'stdio', command: config.command };
  }
  if (url !== undefined && (transport === 'streamable-http' || transport === 'http')) {
    const headers =
      typeof config.headers === 'object' && config.headers !== null && !Array.isArray(config.headers)
        ? (config.headers as Record<string, string>)
        : undefined;
    return headers === undefined ? { type: 'http', url } : { type: 'http', url, headers };
  }
  if (url !== undefined && transport === 'sse') {
    return { type: 'sse', url };
  }
  return undefined;
}

/** 读一个 JSON 文件；不存在或解析失败都返回 undefined（不当作空覆盖）。 */
function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把 searchfuse 的 MCP 配置同步进 omp。
 *
 * **只补缺，不覆盖**：
 * - omp 的 `mcp.json` 里已有的 server 一律不动（用户可能已经自己调过）
 * - 只补 omp 里没有、而 searchfuse 配置里有的那些
 * - `disabledServers` 原样保留
 *
 * 这样「已安装的话会自动处理」——用户装的不会被我们的默认值踩掉。
 */
export function syncOmpMcp(searchfuseConfig: Record<string, unknown>, file = ompMcpPath()): {
  added: string[];
  changed: boolean;
  backup?: string;
} {
  const existing = readJsonFile(file) ?? {};
  const existingServers =
    typeof existing.mcpServers === 'object' && existing.mcpServers !== null && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  const sourceMcp =
    typeof searchfuseConfig.mcp === 'object' && searchfuseConfig.mcp !== null && !Array.isArray(searchfuseConfig.mcp)
      ? (searchfuseConfig.mcp as Record<string, unknown>)
      : {};

  const added: string[] = [];
  const nextServers: Record<string, unknown> = { ...existingServers };
  for (const [name, rawConfig] of Object.entries(sourceMcp)) {
    // 已有就跳过：不覆盖用户自己的设置。
    if (Object.hasOwn(nextServers, name)) continue;
    if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) continue;
    const server = toOmpServer(rawConfig as Record<string, unknown>);
    if (server === undefined) continue;
    nextServers[name] = server;
    added.push(name);
  }

  if (added.length === 0) {
    return { added: [], changed: false };
  }

  const next = `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`;
  const decision = decideWrite(file, next);
  if (decision.changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, 'utf-8');
  }
  return decision.backup === undefined
    ? { added, changed: decision.changed }
    : { added, changed: decision.changed, backup: decision.backup };
}

/**
 * 报告 Claude Code 侧**已经装着**的 MCP server。
 *
 * 为什么不往里写：Claude Code 的 MCP 有自己的配置层级（`~/.claude.json`
 * 的 `mcpServers`），用户可能已经装好并调过。插件的 `plugin.json` 里再声明
 * 一遍同名 server 会造成「两个同名、谁生效」的歧义。所以这里只读不写，
 * 由 `hosts sync` 打印出来告诉用户「这些已经在用」。
 *
 * omp 会自动从 `~/.claude.json` 导入（宿主源码 `claude-paths.ts` 确认），
 * 所以 Claude 侧装了的，omp 那边也能拿到。
 */
export function reportClaudeMcp(claudeJsonPath = claudeUserConfigPath()): string[] {
  const raw = readJsonFile(claudeJsonPath);
  if (raw === undefined) return [];
  const servers = raw.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return [];
  return Object.keys(servers);
}

/** Claude Code 的用户配置文件（MCP 与全局状态都在这里）。 */
export function claudeUserConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * 一个宿主当前的接入状态。
 *
 * 这是**只读**检测：它报告「现在是什么样」，不修任何东西。设置卡片需要
 * 在表面显示「omp 接上了没」「Claude Code 的插件加载成没成」，而这件事
 * 只能靠看文件回答——没有哪个宿主提供「你现在有没有接上我」的接口。
 */
export interface HostStatus {
  /** 扩展/技能文件是否已经落地。 */
  installed: boolean;
  /** 已落地但内容与仓库源不一致的条目；空表示完全对齐。 */
  stale: string[];
  /** 缺了哪些应为文件。`installed` 为 true 时仍可能非空（装了一半）。 */
  missing: string[];
  /** 配置里那条接线还在不在（omp 的 searxng.endpoint / Claude 的 enabled）。 */
  wired: boolean;
}

/** omp 扩展在扩展目录里的文件名。 */
const OMP_EXTENSION_FILE = 'searchfuse.ts';

/** 读 omp 的 config.yml，判断三个接线键是否齐全。 */
function ompWired(file = ompConfigPath()): boolean {
  const text = readOmpConfig(file);
  if (text === '') return false;
  // 只需要判断「这两个键有没有非空值」，不必完整解析 YAML。
  const hasEndpoint = /^\s*endpoint:\s*[^\s#]/m.test(text);
  const hasToken = /^\s*token:\s*[^\s#]/m.test(text);
  return hasEndpoint && hasToken;
}

/**
 * omp 的接入状态。
 *
 * `installed` 看扩展文件在不在，`stale` 比对内容与传入的源文本——两者分开
 * 是因为它们对应两种不同的故障：「没装」要装，「装了但旧了」要重新同步，
 * 而后者最容易骗人：文件明明在，行为却还是旧的。
 *
 * **比对前必须先把源模板渲染一遍。** 安装时 `installOmpExtension` 会把
 * `__SEARCHFUSE_KERNEL_PATH__` 换成真实路径，所以已安装文件的文本永远不等于
 * 模板原文。直接拿模板比，就等于把每一次正确的安装都报成陈旧——卡片上的
 * 「需要更新」会变成永远消不掉的假提示。渲染是同一个函数，口径就一致了。
 */
export function ompStatus(
  source: string | undefined,
  dir = ompExtensionsDir(),
  kernelPath = '',
): HostStatus {
  const file = path.join(dir, OMP_EXTENSION_FILE);
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, 'utf-8');
  } catch {
    current = undefined;
  }
  const missing: string[] = current === undefined ? [OMP_EXTENSION_FILE] : [];
  const stale: string[] = [];
  if (current !== undefined && source !== undefined) {
    // 与 installOmpExtension 用同一套渲染，避免「装了却报旧」的假阳性。
    const escaped = JSON.stringify(kernelPath).slice(1, -1);
    const expected = source.replaceAll('__SEARCHFUSE_KERNEL_PATH__', escaped);
    if (current !== expected) stale.push(OMP_EXTENSION_FILE);
  }
  return {
    installed: current !== undefined,
    stale,
    missing,
    wired: ompWired(),
  };
}

/**
 * Claude Code 的 mod 接入状态。
 *
 * 与 omp 的区别在于「开关归谁管」：omp 靠删文件来关闭（它没有运行时开关），
 * 而 Claude 的 `register.ts` 每次调用都读 `searchfuseHosts.claudeCode.enabled`。
 * 所以这里多一个 `enabled`，它来自设置文件而不是文件在不在——目录留着、
 * 开关关掉，是一份完全合法且有意义的状态。
 */
export function claudeStatus(
  sourceDir: string | undefined,
  targetDir = claudeSkillDir(),
): HostStatus & { enabled: boolean } {
  const missing: string[] = [];
  const stale: string[] = [];
  let present = 0;
  for (const relative of CLAUDE_MOD_FILES) {
    const to = path.join(targetDir, relative);
    let current: string | undefined;
    try {
      current = fs.readFileSync(to, 'utf-8');
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      missing.push(relative);
      continue;
    }
    present += 1;
    if (sourceDir !== undefined) {
      let source: string | undefined;
      try {
        source = fs.readFileSync(path.join(sourceDir, relative), 'utf-8');
      } catch {
        // 源文件缺席不是「旧了」，只是这一项我们还不知道该怎么比。
        source = undefined;
      }
      if (source !== undefined && current !== source) {
        stale.push(relative);
      }
    }
  }
  return {
    installed: present > 0,
    stale,
    missing,
    // Claude 的接线状态写在插件自己的设置文件里，不在这里判断；调用方
    // 从自己的配置里读 enabled，避免 hosts.ts 依赖插件配置的形状。
    wired: present === CLAUDE_MOD_FILES.length,
    enabled: true,
  };
}
