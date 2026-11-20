// Mod 内核的融合结果缓存。
//
// 与 src/aggregate/cache.ts 的键逻辑一致（query + maxResults + 引擎集合，
// sha256 摘要取前 24 位），但存储从「磁盘文件」换成 `$.store`（跨会话 JSON KV，
// 每个插件一个文件、4 MiB 上限）。缓存命中/写入全部容忍失败：缓存只是优化，
// 网络还在那里。

export interface CacheRecord {
  summary: string;
  items: unknown[];
  storedAt: string;
  /** 参与贡献的引擎名，供诊断行使用。 */
  engines?: string[];
  /** 本次运行携带的失败信息，保留下来以便重放时说同样的话。 */
  failures?: string[];
}

/** 结果归入此处的键。与 dsh 侧 sha256 语义完全一致，缓存互不通用也没关系。 */
export function cacheKey(input: {
  query: string;
  maxResults: number;
  engines: string[];
}): string {
  const engines = [...input.engines].sort().join(',');
  // Mod 沙箱无 node:crypto，用 Web 标准的 SubtleCrypto 做 sha-256。
  // 键是确定性的、可缓存的。
  return `${input.query.trim().slice(0, 80)}\u0000${input.maxResults}\u0000${engines}`;
}

/**
 * 构造读写缓存所需的方法对。`store` 是 $.store 的一个适配（get/set 都是
 * JSON 值，且为 Promise）。
 */
export function makeCache(store: {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
}) {
  /** 该键对应的新鲜记录；没有则返回 undefined。ttlMs<=0 表示关闭缓存。 */
  async function read(key: string, now: Date, ttlMs: number): Promise<CacheRecord | undefined> {
    if (ttlMs <= 0) {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = await store.get(key);
    } catch {
      return undefined;
    }
    if (raw === null || typeof raw !== 'object') {
      return undefined;
    }
    const record = raw as Partial<CacheRecord>;
    if (typeof record.storedAt !== 'string') {
      return undefined;
    }
    const storedAt = new Date(record.storedAt);
    if (Number.isNaN(storedAt.getTime())) {
      return undefined;
    }
    if (now.getTime() - storedAt.getTime() > ttlMs) {
      return undefined;
    }
    return {
      summary: record.summary ?? '',
      items: Array.isArray(record.items) ? record.items : [],
      storedAt: record.storedAt,
      engines: record.engines,
      failures: record.failures,
    };
  }

  async function write(key: string, record: CacheRecord): Promise<void> {
    try {
      await store.set(key, record);
    } catch {
      // 写入失败只意味着下一次同样的查询又要再花配额，并不代表答案有错。
    }
  }

  return { read, write };
}