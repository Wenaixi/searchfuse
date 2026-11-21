// 内置 SearXNG 实例的生命周期管理。
//
// 目的：让 `engines.searxng` 在**没有填 baseURL** 时也能用——由本进程拉起
// 一个随包的 SearXNG，搜完即走。填了 baseURL 的用户完全不受影响，仍然连
// 自己的实例。
//
// 为什么把二进制交给 `@searxng-js/searxng` 而不是自己 spawn：
// 那个包已经处理了三件容易做错的事：
// 1. 找空闲端口（固定端口会跟用户自己的 SearXNG 撞）
// 2. 生成临时 settings.yml 并清理，并发健康轮询直到就绪
// 3. Windows 上的 onefile launcher 会留下持久的 server 子进程，
//    它用 taskkill /T 杀掉整棵树——自己 spawn 必然漏掉这一层
//
// 本模块只负责“什么时候起、起几个、什么时候停”，不重复那些细节。
import { startServer, type SearxngServer } from '@searxng-js/searxng';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearxngConfig } from '../config.ts';
import { renderSettingsYml } from './searxngSettings.ts';

/** 一次进程内最多复用同一个实例多久，超时就换新的。 */
const IDLE_DISPOSE_MS = 10 * 60 * 1000;

/** 启动超时。冷启动解包约 2-3 秒，留足余量。 */
const START_TIMEOUT_MS = 60_000;

interface Managed {
  server: SearxngServer;
  timer: NodeJS.Timeout;
  /** 生成 settings.yml 的临时目录；实例停掉时要一起删。 */
  tempDir?: string;
  /** 启动时用的配置指纹。配置变了就不能复用这个实例。 */
  signature: string;
}

let current: Managed | undefined;
/** 记住上一次失败的因由，避免每次搜索都重新尝试一遍同样的失败。 */
let lastFailure: string | undefined;
/** 上次失败时的配置指纹：只有配置没变才复用那条失败消息。 */
let lastFailureSignature: string | undefined;

/** 判断「配置变没变」用的指纹。只需能区分，不需要稳定排序之外的性质。 */
function signatureOf(config: SearxngConfig | undefined): string {
  return JSON.stringify(config ?? null);
}

/**
 * 拿一个可用的内置实例。
 *
 * 配置变了就停掉旧实例另起新的：SearXNG 只在启动时读 settings.yml，
 * 没有热重载。复用旧实例会让用户改完代理却毫无效果，那种静默失效比
 * 多花两秒重启糟糕得多。
 */
export async function acquireSearxngServer(config?: SearxngConfig): Promise<SearxngServer> {
  const signature = signatureOf(config);

  if (current !== undefined) {
    if (current.signature === signature) {
      // 还活着、配置也没变：继续用，并重置闲置计时。
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        void disposeSearxngServer();
      }, IDLE_DISPOSE_MS);
      current.timer.unref();
      return current.server;
    }
    // 配置变了：先收掉旧的。
    await disposeSearxngServer();
  }

  // 平台没有预编译二进制时，startServer 会抛错。把上一次的失败原因
  // 直接交出去，省掉每次搜索重新等一次启动超时。
  if (lastFailure !== undefined && current === undefined) {
    // 只有配置没变时才缓存失败；换了配置值得重试一次。
    if (lastFailureSignature === signature) {
      throw new Error(lastFailure);
    }
  }

  let server: SearxngServer;
  let tempDir: string | undefined;
  try {
    const yml = renderSettingsYml(config);
    let settingsPath: string | undefined;
    if (yml !== undefined) {
      tempDir = await mkdtemp(join(tmpdir(), 'searchfuse-searxng-'));
      settingsPath = join(tempDir, 'settings.yml');
      await writeFile(settingsPath, yml, 'utf8');
    }
    server = await startServer({
      timeoutMs: START_TIMEOUT_MS,
      ...(settingsPath !== undefined ? { settingsPath } : {}),
    });
  } catch (error) {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    lastFailure = message;
    lastFailureSignature = signature;
    throw new Error(message);
  }

  const timer = setTimeout(() => {
    void disposeSearxngServer();
  }, IDLE_DISPOSE_MS);
  timer.unref();

  current = { server, timer, signature, ...(tempDir !== undefined ? { tempDir } : {}) };
  return server;
}

/** 关掉当前实例。幂等：没有实例时什么都不做。 */
export async function disposeSearxngServer(): Promise<void> {
  const managed = current;
  if (managed === undefined) return;
  current = undefined;
  clearTimeout(managed.timer);
  try {
    await managed.server.stop();
  } catch {
    // 关不掉就算了：它自己会随本进程退出而被清理（包里挂了 exit 钩子）。
  }
  if (managed.tempDir !== undefined) {
    await rm(managed.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 进程收尾时确保子进程不留下。 */
export function registerSearxngCleanup(): void {
  const handler = (): void => {
    void disposeSearxngServer();
  };
  process.once('exit', handler);
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

/** 测试用：重置内部状态。 */
export function resetSearxngServerForTests(): void {
  current = undefined;
  lastFailure = undefined;
  lastFailureSignature = undefined;
}
