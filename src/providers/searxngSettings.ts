// 把 `searxng` 配置渲染成 SearXNG 的 settings.yml。
//
// 为什么自己写序列化而不是引 yaml 库：要产出的结构是固定的三层
// （outgoing / networks / engines 列表），字段就那么几个；而代理 URL 里
// 有 `:` `/` `@`，引号规则必须自己拿捏。一个 40 行的序列化器比多一个
// 依赖更透明，出错时也更容易定位到具体哪一行。
//
// 打底用 `use_default_settings: true`：用户只写要改的那几条，不必抄一份
// 几百行的默认配置。SearXNG 会在此基础上合并。
import type { SearxngConfig, SearxngProxies } from '../config.ts';

/** 需要加引号的 YAML 标量：含特殊字符就一律包成双引号并转义。 */
function quoted(value: string): string {
  if (value === '') return '""';
  // 保守策略：只要不是纯字母数字和少数几个符号，就加引号。
  // 代理 URL 几乎必然命中，这没关系——多一对引号不会改变语义。
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** 把「字符串或字符串数组」统一成数组。 */
function toList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** 校验代理协议：SearXNG 只认 http(s) 与 socks5(h)。 */
export function validateProxyUrl(proxy: string): string | undefined {
  const trimmed = proxy.trim();
  if (trimmed === '') return 'proxy URL is empty';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `invalid proxy "${trimmed}": include a scheme, e.g. http://127.0.0.1:7890`;
  }
  const allowed = ['http:', 'https:', 'socks5:', 'socks5h:'];
  if (!allowed.includes(parsed.protocol)) {
    return `invalid proxy "${trimmed}": unsupported scheme "${parsed.protocol.replace(':', '')}"; use http, https, socks5, or socks5h`;
  }
  if (parsed.hostname === '') {
    return `invalid proxy "${trimmed}": missing host`;
  }
  return undefined;
}

/** 校验并收集一条 `proxies` 块里所有 URL。返回错误消息或 null。 */
export function validateProxies(proxies: SearxngProxies | undefined, where: string): string | null {
  if (proxies === undefined) return null;
  for (const key of Object.keys(proxies)) {
    if (key !== 'http' && key !== 'https' && key !== 'all://') {
      return `${where}: unknown proxies key "${key}"; use http, https, or all://`;
    }
  }
  for (const [key, raw] of Object.entries(proxies)) {
    if (raw === undefined) continue;
    for (const proxy of toList(raw)) {
      const error = validateProxyUrl(proxy);
      if (error !== undefined) return `${where}.${key}: ${error}`;
    }
  }
  return null;
}

/** 校验整个 `searxng` 段。返回第一条错误消息，或 null 表示没问题。 */
export function validateSearxngConfig(config: SearxngConfig | undefined): string | null {
  if (config === undefined) return null;

  const outgoingError = validateProxies(config.outgoing, 'searxng.outgoing.proxies');
  if (outgoingError !== null) return outgoingError;

  const networks = config.networks ?? {};
  for (const [name, network] of Object.entries(networks)) {
    if (name.trim() === '') return 'searxng.networks: a network name is empty';
    const error = validateProxies(network?.proxies, `searxng.networks.${name}.proxies`);
    if (error !== null) return error;
  }

  // extra_proxy_timeout 属于 outgoing 整体，不在某条网络里：SearXNG 的
  // Network.__init__ 不接受这个名字，写错层会让实例启动直接失败。
  if (config.extra_proxy_timeout !== undefined) {
    const value = config.extra_proxy_timeout;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return 'searxng.extra_proxy_timeout must be a positive number';
    }
  }

  for (const [name, rule] of Object.entries(config.engines ?? {})) {
    if (name.trim() === '') return 'searxng.engines: an engine name is empty';
    if (rule?.network !== undefined && !Object.hasOwn(networks, rule.network)) {
      const known = Object.keys(networks);
      return `searxng.engines.${name}.network "${rule.network}" is not defined in searxng.networks (known: ${
        known.length > 0 ? known.join(', ') : 'none'
      })`;
    }
    const error = validateProxies(rule?.proxies, `searxng.engines.${name}.proxies`);
    if (error !== null) return error;
  }

  return null;
}

/** 渲染一个 `proxies` 的 YAML 块，缩进由调用方给出的层级决定。 */
function renderProxies(proxies: SearxngProxies, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(proxies)) {
    if (raw === undefined) continue;
    const list = toList(raw);
    // 单值也写成列表：SearXNG 对两种写法都接受，但列表形式让
    // 「同一协议多个代理会轮询」这件事在文件里是可见的。
    lines.push(`${indent}${key}:`);
    for (const proxy of list) {
      lines.push(`${indent}  - ${quoted(proxy)}`);
    }
  }
  return lines;
}

/**
 * 渲染完整 settings.yml。
 *
 * 没有配置任何东西时返回 undefined：调用方据此决定用包自带的默认
 * settings，省掉一次写临时文件。
 */
export function renderSettingsYml(config: SearxngConfig | undefined): string | undefined {
  const error = validateSearxngConfig(config);
  if (error !== null) throw new Error(error);
  if (config === undefined) return undefined;

  const hasOutgoing = config.outgoing !== undefined && Object.keys(config.outgoing).length > 0;
  const networkNames = Object.keys(config.networks ?? {});
  const engineNames = Object.keys(config.engines ?? {});
  if (
    !hasOutgoing &&
    config.extra_proxy_timeout === undefined &&
    networkNames.length === 0 &&
    engineNames.length === 0
  ) {
    return undefined;
  }

  // 传了 settingsPath 就完全替代了包自带的 DEFAULT_SETTINGS，所以那几项让
  // 搜索能返回 JSON 的必要设置必须由我们自己写上：`formats: [html, json]`
  // 缺了会 403（实例只肯渲染网页），`limiter: false` 缺了则会被限流器拦。
  const lines: string[] = [
    'use_default_settings: true',
    'general:',
    '  instance_name: searxng',
    'search:',
    '  formats: [html, json]',
    'server:',
    '  limiter: false',
    '  image_proxy: false',
    'valkey:',
    '  url: false',
  ];

  // extra_proxy_timeout 也写在 outgoing 下，所以它一个人就足以让这一段
  // 出现；漏掉它会让一个设置被静默吞掉。
  const hasOutgoingOrNetworks =
    hasOutgoing || config.extra_proxy_timeout !== undefined || networkNames.length > 0;
  if (hasOutgoingOrNetworks) {
    lines.push('outgoing:');
    if (hasOutgoing) {
      lines.push('  proxies:');
      // 这里缩进两层：`outgoing:` -> `proxies:` -> 内容
      lines.push(...renderProxies(config.outgoing as SearxngProxies, '    '));
    }
    if (config.extra_proxy_timeout !== undefined) {
      lines.push(`  extra_proxy_timeout: ${config.extra_proxy_timeout}`);
    }
    if (networkNames.length > 0) {
      lines.push('  networks:');
      for (const name of networkNames) {
        const network = config.networks?.[name];
        if (network === undefined) continue;
        lines.push(`    ${quoted(name)}:`);
        if (network.proxies !== undefined && Object.keys(network.proxies).length > 0) {
          lines.push('      proxies:');
          lines.push(...renderProxies(network.proxies, '        '));
        }
      }
    }
  }

  if (engineNames.length > 0) {
    lines.push('engines:');
    for (const name of engineNames) {
      const rule = config.engines?.[name];
      if (rule === undefined) continue;
      lines.push(`  - name: ${quoted(name)}`);
      if (rule.disabled !== undefined) {
        lines.push(`    disabled: ${rule.disabled ? 'true' : 'false'}`);
      }
      if (rule.network !== undefined) {
        lines.push(`    network: ${quoted(rule.network)}`);
      }
      if (rule.using_tor_proxy !== undefined) {
        lines.push(`    using_tor_proxy: ${rule.using_tor_proxy ? 'true' : 'false'}`);
      }
      if (rule.proxies !== undefined && Object.keys(rule.proxies).length > 0) {
        lines.push('    proxies:');
        lines.push(...renderProxies(rule.proxies, '      '));
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
