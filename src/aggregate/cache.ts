// 融合搜索结果的磁盘缓存。
//
// 放磁盘而不是内存，是因为插件到达 CLI 的方式：每次 `web_search` 调用都会
// 新起一个 `dist/main.js` 进程，所以进程内缓存会在一闪调用里生灭，永远伺候
// 不了第二次调用。
//
// 文件刻意与 state.json 分开。state.json 存的是配额冷却，那是关于外部世界的
// 事实；缓存则是随时可以删掉的便利，把两者混在一起会让「清缓存」和
// 「忘记哪些引擎在冷却」变成同一个操作。
//
// 每一次读取都容忍失败：缺失、写了一半、或被手改坏的文件绝不能拖垮一次搜索，
// 因为缓存只是优化，网络还在那里。
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 一份缓存下来的融合结果：即调用方本会收到的东西。 */
export interface CacheRecord {
  summary: string;
  items: unknown[];
  storedAt: string;
  /** 参与贡献的引擎名，供诊断行使用。 */
  engines?: string[];
  /** 本次运行携带的失败信息，保留下来以便重放时说同样的话。 */
  failures?: string[];
}

export type CacheFile = Record<string, CacheRecord>;

/** 默认位置，放在工具其余部分所读配置的旁边。 */
export function currentCachePath(): string {
  return path.join(os.homedir(), '.searchfuse', 'cache.json');
}

/**
 * 结果归入此处的键。
 *
 * 引擎集合是键的一部分，因为同一个查询由不同引擎集合作答就是不同答案；
 * 但引擎集合的顺序不是，因为那属于路由而非问题本身。查询里的空白字符
 * 出于同样的理由被归一化。
 */
export function cacheKey(input: {
  query: string;
  maxResults: number;
  engines: string[];
}): string {
  const engines = [...input.engines].sort().join(',');
  return createHash('sha256')
    .update(`${input.query.trim()}\u0000${input.maxResults}\u0000${engines}`)
    .digest('hex')
    .slice(0, 24);
}

function loadCacheFile(file: string): CacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as CacheFile;
  } catch {
    // 缺失、读不出、格式坏：全部都只意味着「没有缓存可给」，
    // 绝不是「让搜索失败」。
    return {};
  }
}

function saveCacheFile(file: string, data: CacheFile): void {
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
  } catch {
    // 在没有 chmod 的平台上尽力而为
  }
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = path.join(dir, `.cache.${unique}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 尽力而为
  }
}

/**
 * 该键对应的新鲜记录；没有则返回 undefined。
 *
 * `ttlMs` 传 0 是文档约定的关闭缓存方式：它会让所有条目立即过期，
 * 调用方就不需要额外的开关标志。
 */
export function readCache(
  file: string,
  key: string,
  now: Date,
  ttlMs: number,
): CacheRecord | undefined {
  if (ttlMs <= 0) {
    return undefined;
  }
  const record = loadCacheFile(file)[key];
  if (record === undefined || typeof record.storedAt !== 'string') {
    return undefined;
  }
  const storedAt = new Date(record.storedAt);
  if (Number.isNaN(storedAt.getTime())) {
    return undefined;
  }
  if (now.getTime() - storedAt.getTime() > ttlMs) {
    return undefined;
  }
  return record;
}

export function writeCache(
  file: string,
  key: string,
  record: CacheRecord,
  now: Date,
  cap?: number,
): void {
  const data = loadCacheFile(file);
  data[key] = record;
  // 写入时顺手修剪，文件就能保持有界，不需要后台任务。
  pruneInto(data, now, Number.POSITIVE_INFINITY, cap);
  saveCacheFile(file, data);
}

/** 先丢弃过期条目，然后只保留最新的 `cap` 条。 */
export function pruneCache(file: string, now: Date, ttlMs: number, cap?: number): void {
  const data = loadCacheFile(file);
  pruneInto(data, now, ttlMs, cap);
  saveCacheFile(file, data);
}

function pruneInto(data: CacheFile, now: Date, ttlMs: number, cap?: number): void {
  for (const [key, record] of Object.entries(data)) {
    const storedAt = new Date(record?.storedAt ?? '');
    if (Number.isNaN(storedAt.getTime()) || now.getTime() - storedAt.getTime() > ttlMs) {
      delete data[key];
    }
  }
  if (cap === undefined || Object.keys(data).length <= cap) {
    return;
  }
  const ordered = Object.entries(data).sort(
    (a, b) => new Date(a[1].storedAt).getTime() - new Date(b[1].storedAt).getTime(),
  );
  const excess = ordered.length - cap;
  for (let i = 0; i < excess; i += 1) {
    const key = ordered[i]?.[0];
    if (key !== undefined) {
      delete data[key];
    }
  }
}
