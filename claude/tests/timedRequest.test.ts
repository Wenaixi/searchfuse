import { describe, expect, it, vi } from 'vitest';
import { makeRequestText } from '../engine/timedRequest.ts';

/** 构造一个记录调用的假 $。 */
function fakeDeps() {
  const calls: { kind: 'fetch' | 'curl'; url: string; init?: unknown }[] = [];
  const deps = {
    fetch: vi.fn(async (url: string, init?: unknown) => {
      calls.push({ kind: 'fetch', url, init });
      return { status: 200, ok: true, text: '{}', headers: {} };
    }),
    curlFetch: vi.fn(async (url: string, init?: unknown) => {
      calls.push({ kind: 'curl', url, init });
      return { status: 200, ok: true, text: '{}' };
    }),
  };
  return { deps, calls };
}

describe('mod requestText transport routing', () => {
  it('uses fetch by default (no proxy, default timeout)', async () => {
    const { deps, calls } = fakeDeps();
    const requestText = makeRequestText(deps);
    await requestText('lab', 'https://example.com', { method: 'GET' }, undefined, 30_000, [], undefined);
    expect(calls[0].kind).toBe('fetch');
  });

  it('uses curlFetch when a proxy is configured', async () => {
    const { deps, calls } = fakeDeps();
    const requestText = makeRequestText(deps);
    await requestText('lab', 'https://example.com', { method: 'GET' }, undefined, 30_000, [], 'http://127.0.0.1:10801');
    expect(calls[0].kind).toBe('curl');
    expect(calls[0].init).toMatchObject({ proxy: 'http://127.0.0.1:10801' });
  });

  it('uses curlFetch when timeout is well under 30s', async () => {
    const { deps, calls } = fakeDeps();
    const requestText = makeRequestText(deps);
    await requestText('lab', 'https://example.com', { method: 'GET' }, undefined, 5_000, [], undefined);
    expect(calls[0].kind).toBe('curl');
    expect(calls[0].init).toMatchObject({ timeoutMs: 5_000 });
  });

  it('preserves status and body through fetch', async () => {
    const { deps } = fakeDeps();
    const requestText = makeRequestText(deps);
    const out = await requestText('lab', 'https://example.com', { method: 'GET' }, undefined, 30_000, [], undefined);
    expect(out.response.status).toBe(200);
    expect(out.response.ok).toBe(true);
    expect(out.text).toBe('{}');
  });
});