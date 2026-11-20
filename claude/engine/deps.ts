// 引擎共享的 transport 依赖注入点。
//
// Mod 沙箱单 worker 单会话（插件模块是常驻进程、无热重载双写），所以模块级
// 可变状态在这里是安全的。register 时调用 setEngineDeps，引擎 execute 时
// getEngineDeps 取用。
//
// 各引擎从 src/providers/*.ts 拷过来时：
// - `import { requestText } from '../util/timedRequest.ts'` → 直接改成从本模块拿
// - `AbortSignal.timeout(x)` → signalTimeout(x)
// - `resolveExplicitProxy(...)` → 参数保留透传（curlFetch 真正处理）

import type { RequestText } from './timedRequest.ts';

export interface EngineDeps {
  requestText: RequestText;
  signalTimeout: (ms: number) => AbortSignal;
}

let deps: EngineDeps | undefined;

/** 注册时调用。可重复调用（热重载场景覆盖）。 */
export function setEngineDeps(next: EngineDeps): void {
  deps = next;
}

/** execute 时调用。未注入会抛错（启动时序问题，应尽早暴露）。 */
export function getEngineDeps(): EngineDeps {
  if (!deps) {
    throw new Error(
      'engine deps not injected: call setEngineDeps({ requestText, signalTimeout }) in register',
    );
  }
  return deps;
}