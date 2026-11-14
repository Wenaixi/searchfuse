import { describe, expect, it } from 'vitest';
import { resolveExplicitProxy } from './explicitProxy.ts';

// The `proxy` field on an engine setting is three-valued, and the difference
// between "not set" and "explicitly direct" is the whole point of the feature:
// unset must keep following the machine's http_proxy, while "direct" must
// bypass it. A function that collapsed the two would silently send a user's
// engine traffic through a proxy they asked to avoid.
describe('resolveExplicitProxy', () => {
  it('returns undefined when unset, so the environment keeps deciding', () => {
    expect(resolveExplicitProxy(undefined)).toBeUndefined();
    expect(resolveExplicitProxy('')).toBeUndefined();
    expect(resolveExplicitProxy('   ')).toBeUndefined();
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
