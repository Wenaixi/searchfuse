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

/** One cached fusion: what the caller would have received. */
export interface CacheRecord {
  summary: string;
  items: unknown[];
  storedAt: string;
  /** Engine names that contributed, for the diagnostics line. */
  engines?: string[];
  /** Failure lines the run carried, preserved so a replay says the same thing. */
  failures?: string[];
}

export type CacheFile = Record<string, CacheRecord>;

/** Default location, beside the config the rest of the tool reads. */
export function currentCachePath(): string {
  return path.join(os.homedir(), '.modsearch', 'cache.json');
}

/**
 * The key a result is filed under.
 *
 * The engine set is part of the key because the same query answered by a
 * different set of engines is a different answer — but its ORDER is not, since
 * that is routing rather than part of the question. Whitespace in the query is
 * normalized for the same reason.
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
 * The fresh record for this key, or undefined.
 *
 * `ttlMs` of 0 is the documented way to switch the cache off: it expires
 * everything immediately, so callers need no separate flag.
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

/** Drop expired entries, then keep only the newest `cap`. */
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
