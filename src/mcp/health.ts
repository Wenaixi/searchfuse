// MCP server 的健康检查：判断「这个 server 现在能用吗」。
//
// 为什么需要它：注册一个连不上的 MCP server 的代价是，模型每次想用它都会
// 等超时。比「没有这个工具」更糟——后者模型会直接换个办法。
//
// 设计要点：
//
// - **探测有缓存**：`hosts sync` 或宿主启动时各探一次，结果落盘 5 分钟内复用。
//   没有缓存的话，同一个坏 server 会在每次启动时拖住 3 秒。
// - **失败不抛错**：探测的答案是「能用 / 不能用 / 不知道」，不是异常。
//   调用方据此决定注册哪一个，而不是让整次启动失败。
// - **超时短**：握手只是几次 HTTP 往返，3 秒还没回应就是连不上。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpConnection, type McpServerConfig } from './protocol.ts';

/** 单次探测的握手超时。 */
const PROBE_TIMEOUT_MS = 3_000;

/** 探测结果的复用时长。5 分钟足够避免重复探测，又不至于让结果过时太久。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 一个 server 的健康结论。 */
export interface McpHealth {
  ok: boolean;
  /** 不可用时的原因；可用时为 undefined。 */
  reason?: string;
  /** 结论产生的时间（epoch ms）。 */
  checkedAt: number;
  /** 是否来自缓存。 */
  fromCache: boolean;
}

/** 缓存文件的位置。与配置分离：它是可以随时删掉的缓存。 */
export function mcpHealthPath(): string {
  return path.join(os.homedir(), '.searchfuse', 'mcp-health.json');
}

/** 缓存文件的内容：名字 → 健康结论。 */
type HealthCache = Record<string, McpHealth>;

function readCache(file: string): HealthCache {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: HealthCache = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.ok !== 'boolean' || typeof record.checkedAt !== 'number') continue;
      out[name] = {
        ok: record.ok,
        checkedAt: record.checkedAt,
        fromCache: true,
        ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      };
    }
    return out;
  } catch {
    // 缓存坏了就当没有：它是优化，不是正确性前提。
    return {};
  }
}

function writeCache(file: string, cache: HealthCache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 去掉 fromCache（那是读取时加的标记，不该写进文件）。
    const plain: Record<string, unknown> = {};
    for (const [name, health] of Object.entries(cache)) {
      plain[name] = health.ok
        ? { ok: true, checkedAt: health.checkedAt }
        : { ok: false, checkedAt: health.checkedAt, reason: health.reason };
    }
    fs.writeFileSync(file, `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // 写不了就下次重新探测，不影响功能。
  }
}

/**
 * 探测一个 MCP server 能否完成握手。
 *
 * 判据是「能列出工具」——比只发一个 `initialize` 更严格，因为很多服务端
 * 会接受 initialize 却在 `tools/list` 时才暴露真正的问题（鉴权过期、
 * 上游不可达）。代价是多一次往返，值得。
 */
export async function probeMcpServer(config: McpServerConfig, now: number = Date.now()): Promise<McpHealth> {
  const connection = new McpConnection({ ...config, timeoutMs: PROBE_TIMEOUT_MS });
  try {
    await connection.listTools();
    return { ok: true, checkedAt: now, fromCache: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: reason.slice(0, 200), checkedAt: now, fromCache: false };
  } finally {
    await connection.close();
  }
}

/**
 * 检查一组 server，能用缓存就用缓存。
 *
 * 返回每个 server 的健康结论；调用方据此决定注册哪些。**不可用的不会被
 * 抛出**，只是被标出来——注册与不注册是调用方的决定。
 */
export async function checkMcpHealth(
  servers: Record<string, McpServerConfig>,
  options: { cachePath?: string; maxAgeMs?: number; now?: number } = {},
): Promise<Record<string, McpHealth>> {
  const file = options.cachePath ?? mcpHealthPath();
  const maxAge = options.maxAgeMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now();
  const cached = readCache(file);
  const results: Record<string, McpHealth> = {};
  let dirty = false;

  const pending: Array<[string, McpServerConfig]> = [];
  for (const [name, config] of Object.entries(servers)) {
    const hit = cached[name];
    if (hit !== undefined && now - hit.checkedAt < maxAge) {
      results[name] = hit;
      continue;
    }
    pending.push([name, config]);
  }

  if (pending.length > 0) {
    // 并发探测：串行的话 N 个坏 server 会等 N 个 3 秒。
    const settled = await Promise.all(pending.map(async ([name, config]) => {
      const health = await probeMcpServer(config, now);
      return [name, health] as const;
    }));
    for (const [name, health] of settled) {
      results[name] = health;
      cached[name] = health;
      dirty = true;
    }
  }

  if (dirty) writeCache(file, cached);
  return results;
}

/** 从健康结论里挑出可用的那些。 */
export function usableMcpNames(health: Record<string, McpHealth>): string[] {
  return Object.entries(health)
    .filter(([, value]) => value.ok)
    .map(([name]) => name);
}
