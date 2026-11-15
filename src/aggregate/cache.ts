// A disk cache for fused search results.
//
// On disk rather than in memory because of how the plugin reaches the CLI: each
// `web_search` call spawns a fresh `dist/main.js` process, so an in-process
// cache would be born and die inside one call and never serve a second one.
//
// The file is separate from state.json on purpose. state.json holds quota
// cooldowns, which are facts about the outside world; a cache is a convenience
// that is safe to delete at any time, and mixing the two would make "clear the
// cache" and "forget which engines are cooling" the same operation.
//
// Every read is failure-tolerant: a missing, half-written or hand-edited file
// must never break a search, because the cache is an optimization and the
// network is still there.
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
    // Missing, unreadable or malformed: all mean "no cache to serve", never
    // "fail the search".
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
    // best effort on platforms without chmod
  }
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = path.join(dir, `.cache.${unique}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
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
  // Pruning on write keeps the file bounded without a background job.
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
