import { describe, expect, it } from 'vitest';
import { resolveExplicitProxy } from './explicitProxy.ts';

// The `proxy` field on an engine setting is three-valued, and the difference
// between "not set" and "explicitly direct" is the whole point of the feature:
// unset must keep following the machine's http_proxy, while "direct" must
// bypass it. A function that collapsed the two would silently send a user's
// engine traffic through a proxy they asked to avoid.
describe('resolveExplicitProxy', () => {
  it('goes direct when unset, so a stray http_proxy cannot hijack a search', () => {
    // 默认值曾是「跟随环境变量」。改成直连的理由写在 explicitProxy.ts 里：
    // 本机实测下，一条本地代理只会给公开 API 的调用引入两类故障 ——
    // 代理没开时的连接拒绝，以及把本该 200 的请求变成代理自己的超时。
    expect(resolveExplicitProxy(undefined)).toBeNull();
    expect(resolveExplicitProxy('')).toBeNull();
    expect(resolveExplicitProxy('   ')).toBeNull();
  });

  it('returns undefined only when the user asks for the system proxy by name', () => {
    // 「跟随系统代理」仍然可用，只是从默认值降级成一个显式选择。
    expect(resolveExplicitProxy('system')).toBeUndefined();
    expect(resolveExplicitProxy('  SYSTEM  ')).toBeUndefined();
    expect(resolveExplicitProxy('System')).toBeUndefined();
  });

  it('returns null for the two force-direct spellings', () => {
    expect(resolveExplicitProxy('direct')).toBeNull();
    expect(resolveExplicitProxy('none')).toBeNull();
    expect(resolveExplicitProxy('  DIRECT  ')).toBeNull();
    expect(resolveExplicitProxy('None')).toBeNull();
  });

  it('passes an http(s) proxy URL through, trimmed', () => {
    expect(resolveExplicitProxy('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(resolveExplicitProxy('  https://proxy.example:8080  ')).toBe(
      'https://proxy.example:8080',
    );
    expect(resolveExplicitProxy('http://user:pass@proxy.example:8080')).toBe(
      'http://user:pass@proxy.example:8080',
    );
  });

  it('refuses a value it cannot act on, naming the field', () => {
    // A hand-edited config can hold anything. Falling back to the environment
    // here would hide the typo and quietly proxy traffic the user tried to
    // route elsewhere, so it is refused instead.
    expect(() => resolveExplicitProxy('socks5://127.0.0.1:1080')).toThrow(/proxy/i);
    expect(() => resolveExplicitProxy('ftp://x')).toThrow(/proxy/i);
    expect(() => resolveExplicitProxy('127.0.0.1:7890')).toThrow(/proxy/i);
    expect(() => resolveExplicitProxy('http://')).toThrow(/proxy/i);
  });
});
