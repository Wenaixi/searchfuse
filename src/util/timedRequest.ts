import { EnvHttpProxyAgent, type Dispatcher } from 'undici';
import { formatErrorWithCause } from './errorCause.ts';
import { resolveProxyForUrl } from './proxy.ts';
import { redactSecrets } from './redact.ts';

/**
 * One HTTP request to an engine API with its whole body read under a single
 * deadline. The signal stays armed until the body is in memory: aborting only
 * up to the response headers let a server that streams the body slowly hold
 * the run past its timeout.
 *
 * A timeout reads `<label> timed out after <ms> ms.`, which the cooldown layer
 * treats as transient. Any other transport failure reads `<label> request
 * failed: ...` with the cause attached and the secrets scrubbed. An error
 * response whose body cannot be read comes back with empty text, so the caller
 * still reports the status.
 *
 * The call honors http_proxy / https_proxy / no_proxy the same way the local
 * page fetch does. Node's fetch ignores them unless NODE_USE_ENV_PROXY is set,
 * and a harness that spawns this CLI rarely sets it, so on a machine whose
 * only way out is a proxy every engine failed while page fetches worked.
 */
export async function requestText(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  secrets: ReadonlyArray<string | undefined | null>,
  /**
   * Per-engine proxy override, resolved by `resolveExplicitProxy`: `undefined`
   * follows the machine's proxy variables, `null` forces a direct connection,
   * a string is the proxy to use. Absent keeps the pre-existing behavior.
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
      // `dispatcher` 是 Node/undici 对 fetch 选项的扩展，不在 DOM 的
      // RequestInit 类型里，所以通过类型断言挂上去。
      response = await fetch(url, {
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
