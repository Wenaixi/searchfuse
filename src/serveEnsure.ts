import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePath } from './serve.ts';

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
  /** spawn 到退出码返回的上限，默认 20 秒。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** 探 /healthz 的上限。服务是本机回环，超过就算不通。 */
const HEALTH_TIMEOUT_MS = 2_000;

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

  const code = await new Promise<number | undefined>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(nodeBinary, [cliPath, 'serve', '--ensure'], {
        stdio: 'ignore',
        // dsh 可能跑在没有控制台的宿主里，Windows 会为每个子进程弹黑框。
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, timeoutMs);
    timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      resolve(exit === null ? undefined : exit);
    });
  });

  if (code !== 0) {
    return { started: false, reason: `serve --ensure exited ${code === undefined ? 'abnormally' : code}` };
  }
  const after = readServeRuntimeFile(file);
  if (after === undefined) {
    return { started: false, reason: 'serve --ensure succeeded but wrote no usable runtime.json' };
  }
  return { started: true, port: after.port };
}
