import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePath } from './serve.ts';
import { spawnHidden } from './util/spawnHidden.ts';

/** 拉起/检查的结果。`reason` 只在没起来时出现，给调用方一行可读的解释。 */
export interface EnsureOutcome {
  started: boolean;
  port?: number;
  reason?: string;
}

export interface EnsureOptions {
  /** 拉起子进程用的 node 可执行文件；默认按 PATH 解析裸名 'node'。 */
  nodeBinary?: string;
  /** CLI 入口绝对路径；默认从本文件位置推 ../dist/main.js。 */
  cliPath?: string;
  /** spawn 之后等服务就绪的上限，默认 20 秒。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** 探 /healthz 的上限。服务是本机回环，超过就算不通。 */
const HEALTH_TIMEOUT_MS = 2_000;
/** spawn 之后轮询就绪状态的间隔。 */
const POLL_INTERVAL_MS = 500;

/** 睡一会儿。轮询用，为这点事引入依赖不值得。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 spawn 失败整理成一行可读的原因。 */
function describeSpawnFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `serve --ensure failed to start: ${detail}`;
}

/**
 * 读 `~/.searchfuse/runtime.json`。
 *
 * 文件可能被 `serve --ensure` 写入、被 `serve` 的 close() 删除，也可能
 * 上一次进程被杀后残留成「指向死端口」。所以形状检查必须严格：
 * 端口不是数字就直接当没有，宁可多拉起一次，也不要拿一个坏端口去连。
 */
export function readServeRuntimeFile(
  file = runtimePath(),
): { port: number; token: string } | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port)) return undefined;
    if (typeof parsed.token !== 'string' || parsed.token === '') return undefined;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return undefined;
  }
}

/** 探一次 /healthz。返回是否 200。 */
function healthOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/healthz',
        method: 'GET',
        timeout: HEALTH_TIMEOUT_MS,
        // dsh 与 omp 都走 keep-alive，探针必须主动断开，否则会等连接超时。
        headers: { Connection: 'close' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * 确保本地服务在跑。已在跑就什么都不做。
 *
 * 顺序是「先探文件、再探 /healthz、最后才 spawn」：文件在但服务已死是最阴的
 * 状态（服务不能用、文件却指向它），直接 spawn 会撞上仍被占用的端口。
 *
 * 拉起复用 `serve --ensure` 而不是自己起服务：它已经处理了「端口 0 由内核
 * 分配」「已在跑就 exit 0」两个边界。在插件里重写一遍必然漂移。
 *
 * 就绪的判据是 `/healthz` 通过，不是子进程退出码。`serve --ensure` 只在
 * 「已经在跑」时以 0 退出；真正需要起服务时它会把服务拉起来并**常驻**，
 * 永远等不到 close 事件。等退出码会一路等到超时，然后用 child.kill() 杀掉
 * 刚刚起来的那个服务——这正是本设计要避免的事。所以 spawn 之后就把子进程
 * 交出去（detached + unref），改为轮询健康检查。
 */
export async function ensureServeRunning(options: EnsureOptions = {}): Promise<EnsureOutcome> {
  const file = runtimePath();
  const existing = readServeRuntimeFile(file);
  if (existing !== undefined && (await healthOnce(existing.port))) {
    return { started: false, port: existing.port };
  }

  const cliPath =
    options.cliPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js');
  const nodeBinary = options.nodeBinary ?? 'node';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 子进程的生命周期与本次调用无关：它要么直接退出（已在跑），要么变成
  // 常驻服务。用一个标志记住它是否已经失败退出，好让轮询早点收手。
  let spawnError: unknown;
  let exitedEarly: number | undefined;

  try {
    const child = spawnHidden(nodeBinary, [cliPath, 'serve', '--ensure'], {
      stdio: 'ignore',
      // 让服务脱离父进程的会话：调用方（dsh 宿主）退出时不该把服务带走。
      detached: true,
    });
    child.unref();
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      // 0 是「已经在跑」，非 0 是启动失败。两者都不必再轮询。
      exitedEarly = code === null ? undefined : code;
    });
  } catch (error) {
    // spawn 本身同步抛出的情况（例如参数非法）。
    return { started: false, reason: describeSpawnFailure(error) };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // 先看子进程是否已经给出结论，避免白等满超时。
    if (spawnError !== undefined) {
      return { started: false, reason: describeSpawnFailure(spawnError) };
    }
    // 非 0 退出是明确的启动失败，立刻收手。
    // 退出 0 表示 serve 认为「已经在跑」，但我们在 spawn 之前刚探过 healthz
    // 并且失败过，所以不把它当终局结论——继续轮询，让健康检查说了算。
    if (exitedEarly !== undefined && exitedEarly !== 0) {
      return { started: false, reason: `serve --ensure exited ${exitedEarly}` };
    }

    const runtime = readServeRuntimeFile(file);
    if (runtime !== undefined && (await healthOnce(runtime.port))) {
      return { started: true, port: runtime.port };
    }

    if (Date.now() >= deadline) {
      return {
        started: false,
        reason: `serve did not become healthy within ${timeoutMs} ms`,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
