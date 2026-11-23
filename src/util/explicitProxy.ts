/**
 * 把一个引擎的 `proxy` 设置转成 `requestText` 真正依据的取值。
 *
 * 四种状态，前两种之间的区分正是这个功能的要点：
 *
 * - `null` —— **默认值**。什么都没配置，或者写了 `direct` / `none`，
 *   都表示这个引擎直连，不查 http_proxy。
 * - `undefined` —— 用户显式写了 `system`，要求这个引擎跟随机器上的
 *   http_proxy / https_proxy / no_proxy。
 * - 一个 URL —— 就用那个代理，且只有那个代理承载这个引擎的流量。
 *
 * 为什么默认是直连而不是跟随系统代理：这是本插件的一条实测结论，不是偏好。
 * 本机的 Clash 走混合端口，而搜素引擎的绝大多数调用面对的是公开 API，
 * 经由一条本地代理只会引入两类故障 —— 代理没开时的连接拒绝，以及把
 * 一次本该是 200 的请求变成代理自身的超时。需要走代理的引擎（区域 API、
 * 自建网关）会由用户显式写一个 URL；需要跟随系统代理的则显式写 `system`。
 * 默认值落在「最少惊喜」那一侧：装了就能用，不依赖环境变量。
 *
 * 既不是可识别关键字、又不是完整 http(s) URL 的值会被拒绝，而不是被忽略。
 * 悄悄退回直连会掩盖一处手改出来的笔误，而这正是这个字段存在的意义所在。
 */
export function resolveExplicitProxy(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'direct' || lower === 'none') {
    return null;
  }
  if (lower === 'system') {
    return undefined;
  }
  // 一个代理既需要 undici 能识别的协议，也需要一个能连上的主机；
  // 单写 `http://` 能被解析成 URL，却没有指明任何端点。
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}". Use "direct", "none", "system", or a full http(s) proxy URL such as http://127.0.0.1:7890.`,
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
