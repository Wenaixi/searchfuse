/**
 * 把一个引擎的 `proxy` 设置转成 `requestText` 真正依据的取值。
 *
 * 三种状态，而前两种之间的区分正是这个功能的要点：
 *
 * - `undefined` —— 什么都没配置，于是机器上的 http_proxy / https_proxy /
 *   no_proxy 继续说了算。这是既有行为，也仍是默认。
 * - `null` —— 用户写了 `direct` 或 `none`，要求这个引擎绕过机器本来会用的
 *   任何代理。
 * - 一个 URL —— 就用那个代理，且只有那个代理承载这个引擎的流量。
 *
 * 既不是可识别关键字、又不是完整 http(s) URL 的值会被拒绝，而不是被忽略。
 * 退回环境变量会掩盖一处手改出来的笔误，并悄悄把流量送进用户正想避开的
 * 那个代理——而这正是这个字段存在的意义所在。
 */
export function resolveExplicitProxy(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'direct' || lower === 'none') {
    return null;
  }
  // 一个代理既需要 undici 能识别的协议，也需要一个能连上的主机；
  // 单写 `http://` 能被解析成 URL，却没有指明任何端点。
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}". Use "direct", "none", or a full http(s) proxy URL such as http://127.0.0.1:7890.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}": only http and https proxies are supported, not ${parsed.protocol.replace(':', '')}.`,
    );
  }
  if (parsed.hostname === '') {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}": the URL names no host. Use a full http(s) proxy URL such as http://127.0.0.1:7890.`,
    );
  }
  return trimmed;
}
