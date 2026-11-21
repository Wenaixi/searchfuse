import { describe, expect, it } from 'vitest';
import { renderSettingsYml, validateSearxngConfig, validateProxyUrl } from './searxngSettings.ts';

describe('searxng settings.yml rendering', () => {
  it('renders nothing when the section configures nothing', () => {
    // 没有配置时用包自带的默认 settings，省掉一次写临时文件。
    expect(renderSettingsYml(undefined)).toBeUndefined();
    expect(renderSettingsYml({})).toBeUndefined();
    expect(renderSettingsYml({ networking: {} } as never)).toBeUndefined();
  });

  it('always asks SearXNG to merge on top of its own defaults', () => {
    // 用户只写要改的那几条，不必抄一份几百行的默认配置。
    const yml = renderSettingsYml({ engines: { brave: { disabled: true } } });
    const text = yml ?? '';
    // 必要的基础段必须自带：传 settingsPath 就完全替代了包里的
    // DEFAULT_SETTINGS，少了 formats 会 403、少了 limiter 会被限流。
    expect(text).toMatch(/formats: \[html, json\]/);
    expect(text).toMatch(/limiter: false/);
    expect(text.trimEnd().endsWith('    disabled: true')).toBe(true);
  });

  it('writes one proxy per protocol and keeps round-robin order', () => {
    // 同一协议下的多个代理是轮询顺序，写盘时必须原样保留数组顺序。
    const yml = renderSettingsYml({
      outgoing: { 'all://': ['http://p1:8080', 'http://p2:8080'] },
    });
    expect(yml).toContain('outgoing:');
    expect(yml).toContain('  proxies:');
    expect(yml).toContain('    all://:');
    expect(yml).toContain('      - "http://p1:8080"');
    expect(yml).toContain('      - "http://p2:8080"');
  });

  it('quotes proxy URLs so YAML keeps them whole', () => {
    // 代理 URL 带 `:` `@`，不加引号会被 YAML 切成别的东西。
    const yml = renderSettingsYml({
      engines: { brave: { proxies: { https: ['socks5h://user:pass@127.0.0.1:1080'] } } },
    });
    expect(yml).toContain('- "socks5h://user:pass@127.0.0.1:1080"');
  });

  it('places extra_proxy_timeout under outgoing, not under a network', () => {
    // 这是实测踩到的坑：SearXNG 的 Network.__init__ 不接受这个名字，
    // 写在 networks.<name> 下会让实例启动直接抛 TypeError。
    const yml = renderSettingsYml({
      extra_proxy_timeout: 10,
      networks: { via_tor: { proxies: { 'all://': ['socks5h://127.0.0.1:9050'] } } },
    });
    expect(yml).toContain('  extra_proxy_timeout: 10');
    expect(yml).not.toMatch(/extra_proxy_timeout:\s*10\n\s+proxies:/);
    // 它必须与 networks 同级（同为 outgoing 的子键），而不是嵌进网络里。
    const lines = (yml as string).split('\n');
    const index = lines.findIndex((line) => line.includes('extra_proxy_timeout'));
    expect(lines[index]).toBe('  extra_proxy_timeout: 10');
  });

  it('renders a named network that an engine can reference', () => {
    const yml = renderSettingsYml({
      networks: {
        via_tor: { proxies: { 'all://': ['socks5h://127.0.0.1:9050'] } },
      },
      engines: { google: { network: 'via_tor' } },
    });
    expect(yml).toContain('  networks:');
    expect(yml).toContain('    "via_tor":');
    expect(yml).toContain('      proxies:');
    expect(yml).toContain('  - name: "google"');
    expect(yml).toContain('    network: "via_tor"');
  });

  it('renders the per-engine switches SearXNG documents', () => {
    const yml = renderSettingsYml({
      engines: {
        startpage: { using_tor_proxy: true },
        duckduckgo: { disabled: true },
      },
    });
    expect(yml).toContain('    using_tor_proxy: true');
    expect(yml).toContain('    disabled: true');
  });
});

describe('searxng config validation', () => {
  it('accepts every proxy scheme SearXNG documents', () => {
    for (const scheme of ['http', 'https', 'socks5', 'socks5h']) {
      expect(validateProxyUrl(`${scheme}://127.0.0.1:1080`)).toBeUndefined();
    }
  });

  it('names the missing scheme instead of failing later inside the instance', () => {
    expect(validateProxyUrl('127.0.0.1:7890')).toMatch(/include a scheme/);
  });

  it('rejects an unsupported scheme and says which are allowed', () => {
    expect(validateProxyUrl('ftp://127.0.0.1:21')).toMatch(/unsupported scheme "ftp".*socks5h/s);
  });

  it('rejects a network reference nobody defined', () => {
    // 本地就拦下来，别等实例启动时才报一个看不懂的 Python 栈。
    expect(
      validateSearxngConfig({ engines: { brave: { network: 'via_tor' } } }),
    ).toMatch(/brave\.network "via_tor" is not defined.*known: none/);
  });

  it('lists the defined networks in the error so the fix is obvious', () => {
    expect(
      validateSearxngConfig({
        networks: { home: { proxies: { 'all://': ['http://127.0.0.1:7890'] } } },
        engines: { brave: { network: 'via_tor' } },
      }),
    ).toMatch(/known: home/);
  });

  it('rejects an unknown protocol key in a proxies block', () => {
    expect(
      validateSearxngConfig({ outgoing: { ftp: ['http://p:1'] } as never }),
    ).toMatch(/unknown proxies key "ftp"; use http, https, or all:\/\//);
  });

  it('rejects a non-positive extra_proxy_timeout', () => {
    expect(validateSearxngConfig({ extra_proxy_timeout: 0 })).toMatch(/must be a positive number/);
    expect(validateSearxngConfig({ extra_proxy_timeout: -5 })).toMatch(/must be a positive number/);
  });

  it('refuses to render an invalid configuration rather than writing a broken file', () => {
    expect(() =>
      renderSettingsYml({ engines: { brave: { network: 'missing' } } }),
    ).toThrow(/brave\.network "missing" is not defined/);
  });
});
