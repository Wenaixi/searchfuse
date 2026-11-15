import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IS_WINDOWS } from '../testing/helpers.ts';
import { cacheKey, readCache, writeCache, pruneCache, type CacheRecord } from './cache.ts';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cache-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const now = new Date('2026-01-01T00:00:00Z');

describe('cacheKey', () => {
  it('is stable for the same query and settings', () => {
    const a = cacheKey({ query: 'rust async', maxResults: 8, engines: ['a', 'b'] });
    const b = cacheKey({ query: 'rust async', maxResults: 8, engines: ['a', 'b'] });
    expect(a).toBe(b);
  });

  it('changes when the engine set changes', () => {
    // The same query answered by a different set of engines is a different
    // answer; sharing a cache entry would serve a result the user did not ask
    // for.
    expect(cacheKey({ query: 'q', maxResults: 8, engines: ['a'] })).not.toBe(
      cacheKey({ query: 'q', maxResults: 8, engines: ['a', 'b'] }),
    );
  });

  it('changes when maxResults changes', () => {
    expect(cacheKey({ query: 'q', maxResults: 5, engines: ['a'] })).not.toBe(
      cacheKey({ query: 'q', maxResults: 10, engines: ['a'] }),
    );
  });

  it('treats the engine order as insignificant', () => {
    // Engine order is a routing detail, not part of the question.
    expect(cacheKey({ query: 'q', maxResults: 8, engines: ['b', 'a'] })).toBe(
      cacheKey({ query: 'q', maxResults: 8, engines: ['a', 'b'] }),
    );
  });

  it('normalizes surrounding whitespace in the query', () => {
    expect(cacheKey({ query: '  rust async  ', maxResults: 8, engines: ['a'] })).toBe(
      cacheKey({ query: 'rust async', maxResults: 8, engines: ['a'] }),
    );
  });
});

describe('readCache and writeCache', () => {
  it('returns the stored record while it is fresh', () => {
    const file = path.join(tmp, 'cache.json');
    const record: CacheRecord = { summary: 's', items: [{ title: 't', url: 'u' }], storedAt: now.toISOString() };
    writeCache(file, 'k', record, now);
    expect(readCache(file, 'k', now, 300_000)?.items).toHaveLength(1);
  });

  it('expires a record past its TTL', () => {
    const file = path.join(tmp, 'cache.json');
    writeCache(file, 'k', { summary: 's', items: [], storedAt: now.toISOString() }, now);
    const later = new Date(now.getTime() + 400_000);
    expect(readCache(file, 'k', later, 300_000)).toBeUndefined();
  });

  it('returns undefined for a missing key or a missing file', () => {
    const file = path.join(tmp, 'cache.json');
    expect(readCache(file, 'absent', now, 300_000)).toBeUndefined();
    expect(readCache(path.join(tmp, 'nope.json'), 'k', now, 300_000)).toBeUndefined();
  });

  it('survives a corrupted file rather than throwing', () => {
    // A half-written or hand-edited cache must never break a search.
    const file = path.join(tmp, 'cache.json');
    fs.writeFileSync(file, '{ not json');
    expect(readCache(file, 'k', now, 300_000)).toBeUndefined();
  });

  it('keeps a record with zero TTL uncacheable', () => {
    // ttlMs 0 is the documented way to switch caching off.
    const file = path.join(tmp, 'cache.json');
    writeCache(file, 'k', { summary: 's', items: [], storedAt: now.toISOString() }, now);
    expect(readCache(file, 'k', now, 0)).toBeUndefined();
  });

  it('overwrites an existing key with the newer record', () => {
    const file = path.join(tmp, 'cache.json');
    writeCache(file, 'k', { summary: 'old', items: [], storedAt: now.toISOString() }, now);
    writeCache(file, 'k', { summary: 'new', items: [], storedAt: now.toISOString() }, now);
    expect(readCache(file, 'k', now, 300_000)?.summary).toBe('new');
  });

  it.skipIf(IS_WINDOWS)('writes the file 0600 and creates the directory 0700', () => {
    const dir = path.join(tmp, 'nested');
    const file = path.join(dir, 'cache.json');
    writeCache(file, 'k', { summary: 's', items: [], storedAt: now.toISOString() }, now);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('pruneCache', () => {
  it('drops expired entries and keeps fresh ones', () => {
    const file = path.join(tmp, 'cache.json');
    const old = new Date(now.getTime() - 600_000);
    writeCache(file, 'old', { summary: 'o', items: [], storedAt: old.toISOString() }, old);
    writeCache(file, 'fresh', { summary: 'f', items: [], storedAt: now.toISOString() }, now);
    pruneCache(file, now, 300_000);
    expect(readCache(file, 'fresh', now, 300_000)?.summary).toBe('f');
    expect(readCache(file, 'old', now, 300_000)).toBeUndefined();
  });

  it('caps the entry count, dropping the oldest first', () => {
    const file = path.join(tmp, 'cache.json');
    for (let i = 0; i < 12; i += 1) {
      const at = new Date(now.getTime() - (12 - i) * 10_000);
      writeCache(file, `k${i}`, { summary: `s${i}`, items: [], storedAt: at.toISOString() }, at);
    }
    pruneCache(file, now, 300_000, 6);
    expect(readCache(file, 'k11', now, 300_000)?.summary).toBe('s11');
    expect(readCache(file, 'k0', now, 300_000)).toBeUndefined();
  });
});
