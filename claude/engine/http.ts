// Mod 内核的传输层：两条路径，按引擎需求选择。
//
// 路径一 `fetch`：`$.http.fetch`。简单、零依赖、跨平台。能用就用它。
//   能带：method / headers / body，返回 status / ok / text / headers（小写 key）。
//   做不到：代理、可配超时（固定 30 秒）、取消（无 signal）、流式。
//
// 路径二 `curlFetch`：`$.process.spawn(['curl', ...])`。为需要代理、短超时
//   或可取消的引擎准备。能带：env 里的 HTTPS_PROXY、--max-time、
//   next.signal（abort 会杀掉子进程）。
//   代价：机器上得有 curl；输出是字节流需自己解析状态码。
//
// 何时用哪条：引擎配了 `proxy` 字段、需要短超时、或目标是本机地址
// （SearXNG 在 127.0.0.1，`$.http.fetch` 对 localhost 可能直接拒绝）时，
// 走 curlFetch；其余走 fetch。

export interface FetchResult {
  status: number;
  ok: boolean;
  text: string;
  /** 响应头，键已小写。curlFetch 也能填。 */
  headers?: Record<string, string>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchFn = (url: string, init?: FetchInit) => Promise<FetchResult>;

/** $ 的最小形状：只声明我们用到的那几个。 */
export interface ModDollar {
  http: {
    fetch: (url: string, init?: FetchInit) => Promise<{
      status: number;
      ok: boolean;
      text: string;
      headers?: Record<string, string>;
    }>;
  };
  process: {
    spawn: (
      argv: string[],
      init?: {
        env?: Record<string, string>;
        cwd?: string;
        stdin?: string;
        timeoutMs?: number;
      },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
}

/** 默认路径：直接把 $.http.fetch 包一层。 */
export function makeFetch($: ModDollar): FetchFn {
  return async (url, init) => {
    const response = await $.http.fetch(url, init);
    return {
      status: response.status,
      ok: response.ok,
      text: response.text,
      headers: response.headers,
    };
  };
}

export interface CurlOptions extends FetchInit {
  /** 走什么代理；空表示不走。对应 curl 的 -x。 */
  proxy?: string;
  /** 超时毫秒。默认 30000，与 $.http.fetch 的固定上限一致。 */
  timeoutMs?: number;
  /** 取消信号。abort 会杀掉 curl 子进程。 */
  signal?: AbortSignal;
}

/**
 * 特殊路径：用 curl 发请求。
 *
 * 状态码靠 `-w '\n%{http_code}'` 附在 body 末尾，最后一个换行后的数字就是它。
 * body 本身可能含换行，所以只从末尾剥一次。
 */
export function makeCurlFetch($: ModDollar): (url: string, opts?: CurlOptions) => Promise<FetchResult> {
  return async (url, opts) => {
    const argv = ['curl', '-sS', '-X', opts?.method ?? 'GET'];
    const timeoutSec = Math.max(1, Math.ceil((opts?.timeoutMs ?? 30_000) / 1000));
    argv.push('--max-time', String(timeoutSec));
    if (opts?.proxy) {
      argv.push('-x', opts.proxy);
    }
    for (const [name, value] of Object.entries(opts?.headers ?? {})) {
      argv.push('-H', `${name}: ${value}`);
    }
    if (opts?.body !== undefined) {
      argv.push('--data-binary', opts.body);
    }
    // 只取 body 与状态码；-o - 把 body 写 stdout。
    argv.push('-o', '-', '-w', '\n%{http_code}', url);

    const result = await $.process.spawn(argv, {
      timeoutMs: Math.min(opts?.timeoutMs ?? 30_000, 600_000),
    });
    const raw = result.stdout;
    const lastNewline = raw.lastIndexOf('\n');
    const statusTail = lastNewline === -1 ? '' : raw.slice(lastNewline + 1).trim();
    const body = lastNewline === -1 ? raw : raw.slice(0, lastNewline);
    const status = Number.parseInt(statusTail, 10);
    if (!Number.isFinite(status)) {
      throw new Error(
        `curl did not report a status for ${url}${result.stderr ? `: ${result.stderr.trim().slice(0, 200)}` : ''}`,
      );
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      text: body,
    };
  };
}