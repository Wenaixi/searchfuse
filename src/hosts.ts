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
 * 装 omp 扩展：把模板里的两个绝对路径替换掉，写到 omp 的扩展目录。
 *
 * 为什么是渲染而不是复制：扩展被复制到 `~/.omp/agent/extensions/` 之后，
 * 它与本包的 `dist/` 已无相对关系，必须把绝对路径写进去才能拉起服务。
 */
export function installOmpExtension(source: string, distServePath: string, tokenPath: string): string {
  const rendered = source
    .replaceAll('__SEARCHFUSE_SERVE_PATH__', distServePath)
    .replaceAll('__SEARCHFUSE_TOKEN_PATH__', tokenPath);
  const dir = ompExtensionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'searchfuse.ts');
  fs.writeFileSync(target, rendered, 'utf-8');
  return target;
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
export function syncClaudeSettings(enabled: boolean, file = claudeSettingsPath()): {
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
  if (claude.enabled === enabled) {
    return { changed: false };
  }

  raw.searchfuseHosts = { ...existing, claudeCode: { ...claude, enabled } };
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
