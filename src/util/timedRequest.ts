import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { formatErrorWithCause } from './errorCause.ts';
import { resolveProxyForUrl } from './proxy.ts';
import { redactSecrets } from './redact.ts';

/**
 * 对引擎 API 的一次 HTTP 请求，整个响应体的读取都在同一个截止时间内完成。
 * 信号会一直武装到响应体进入内存为止：只在等到响应头之前就中断，会让一个
 * 慢慢吐响应体的服务端把整轮运行拖过它的超时。
 *
 * 超时读作 `<label> timed out after <ms> ms.`，冷却层会把它视为瞬时故障。
 * 其他传输失败读作 `<label> request failed: ...`，附带原因且密钥已脱敏。
 * 错误响应如果响应体读不出来，会带着空文本返回，调用方仍能报告状态码。
 *
 * 这个调用对 http_proxy / https_proxy / no_proxy 的处理与本地页面抓取一致。
 * Node 的 fetch 只有在设置了 NODE_USE_ENV_PROXY 时才会理会它们，而启动本 CLI
 * 的宿主很少设置它，所以在一条只能走代理出网的机器上，会出现所有引擎都失败、
 * 而页面抓取却正常的情况。
 */
export async function requestText(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  secrets: ReadonlyArray<string | undefined | null>,
  /**
   * 单引擎的代理覆盖，由 `resolveExplicitProxy` 解析：`undefined`
   * 表示沿用本机的代理环境变量，`null` 表示强制直连，字符串则是要使用的
   * 代理。缺省时保持原有行为。
   */
  explicitProxy?: string | null,
): Promise<{ response: Response; text: string }> {
  const fail = (error: unknown): Error =>
    signal.aborted
      ? new Error(`${label} timed out after ${timeoutMs} ms.`)
      : new Error(
          `${label} request failed: ${redactSecrets(
            formatErrorWithCause(error),
            secrets,
          )}`,
        );

  // 显式设置自己说了算，而且两个方向都算：`null` 意味着直连，
  // 且绝不能去查 http_proxy，所以这是一个严格的三路分支，而不是真值判断。
  //
  // `undefined` 现在的含义是「用户显式要求跟随系统代理」（见
  // util/explicitProxy.ts）：默认已经翻成直连，所以这条分支只在有人写了
  // `proxy: system` 时才走到。
  const proxyUrl =
    explicitProxy === undefined ? resolveProxyForUrl(new URL(url), process.env) : explicitProxy;
  // NO_PROXY 上面已经应用过了，所以这里给代理一个空的，让它总是使用
  // 交给它的那个代理。
  const dispatcher = proxyUrl
    ? new EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: '' })
    : undefined;
  try {
    let response: Response;
    try {
      // 传了 dispatcher 时必须用 undici 自己的 fetch：全局 fetch 是 Node 内置
      // 的 undici，版本跟着 Node 走（Node 22.23 内置 6.29），而这里的
      // dispatcher 来自 npm 装的 undici 8，两个大版本的 handler 契约不兼容，
      // 内置 fetch 会抛 `invalid onRequestStart method`，且只在旧 Node 上复现。
      // 没有 dispatcher 时用全局 fetch：那条路径不碰 undici 内部契约，
      // 而且测试都是 stubGlobal('fetch') 打桩的，换成 undiciFetch 就打不中。
      // `dispatcher` 是 Node/undici 对 fetch 选项的扩展，不在 DOM 的
      // RequestInit 类型里，所以通过类型断言挂上去。
      const doFetch = dispatcher ? undiciFetch : fetch;
      response = await doFetch(url, {
        ...init,
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: Dispatcher });
    } catch (error) {
      throw fail(error);
    }
    try {
      return { response, text: await response.text() };
    } catch (error) {
      if (!response.ok && !signal.aborted) {
        return { response, text: '' };
      }
      throw fail(error);
    }
  } finally {
    await dispatcher?.close();
  }
}
