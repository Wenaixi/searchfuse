// Mod 内核的 requestText：签名对齐 dsh 侧 src/util/timedRequest.ts，
// 内部按引擎需求在 fetch / curlFetch 之间分发。
//
// 引擎从 src/providers/*.ts 拷过来时，调用点签名一字不动：
//   requestText(label, url, init, signal, timeoutMs, secrets, explicitProxy)
//
// 分发规则：
// - explicitProxy 不是 undefined/null（用户配了 proxy）→ 走 curlFetch。
// - timeoutMs 有值且明显短于 30 秒 → 走 curlFetch（fetch 无法配更短超时）。
// - 其余走 fetch（简单路径）。
//
// dsh 侧的参数中有两个在 Mod 沙箱没有对应物：
// - signal：fetch 路径不可取消；curlFetch 路径若传入 AbortSignal 则接上。
// - secrets：脱敏仍在引擎层做（redactSecrets），这里只透传无用。
//
// 工厂在 register 时拿到 $，产出 requestText 供引擎用。

import type { FetchFn } from './http.ts';

export interface RequestTextResult {
  response: {
    status: number;
    ok: boolean;
    statusText: string;
    headers: { get: (name: string) => string | null };
  };
  text: string;
}

export interface RequestTextDeps {
  fetch: FetchFn;
  curlFetch: (
    url: string,
    opts?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      proxy?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ) => Promise<{ status: number; ok: boolean; text: string }>;
}

export function makeRequestText(deps: RequestTextDeps) {
  return async function requestText(
    _label: string,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    signal?: AbortSignal,
    timeoutMs?: number,
    _secrets?: ReadonlyArray<string | undefined | null>,
    explicitProxy?: string | null,
  ): Promise<RequestTextResult> {
    const needsCurl =
      (explicitProxy !== undefined && explicitProxy !== null) ||
      (typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs < 28_000);

    let status: number;
    let text: string;
    try {
      if (needsCurl) {
        const out = await deps.curlFetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          proxy: explicitProxy ?? undefined,
          timeoutMs,
          signal,
        });
        status = out.status;
        text = out.text;
      } else {
        const out = await deps.fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
        });
        status = out.status;
        text = out.text;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(reason);
    }

    return {
      response: {
        status,
        ok: status >= 200 && status < 300,
        statusText: status >= 200 && status < 300 ? 'OK' : `HTTP ${status}`,
        headers: { get: () => null },
      },
      text,
    };
  };
}

export type RequestText = ReturnType<typeof makeRequestText>;