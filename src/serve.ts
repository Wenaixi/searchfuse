// 本地 HTTP 服务：把 searchfuse 的聚合能力暴露成 omp 能吃的形状。
//
// 为什么需要它：omp 的搜索后端是封闭枚举（`SearchProviderId`），不能注册
// 自定义 provider，但它原生支持 `searxng` provider，且 `searxng.endpoint`
// 接受任意 URL。所以这里提供一个 SearXNG 兼容的壳，omp 用一行配置接进来。
//
// dsh 与 Claude Code 不走这里——它们直接 spawn `dist/kernel.js`。这个服务
// 只为 omp 存在，所以它只需要满足 omp 的那部分契约。

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { allowsPrivateNetwork, currentConfigPath, loadConfigFile } from './config.ts';
import { runSearch } from './search.ts';

/**
 * `Promise.withResolvers` 在 Node 20+ 的运行时存在，但本仓库的 tsconfig
 * 用的是 ES2022 lib，类型里没有它。为一个语法糖把全局 lib 升到 ES2024
 * 会牵动整个项目的类型基线，不值得；所以在本地补一条声明，只影响这个文件。
 */
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
  }
}

/** SearXNG 兼容单条结果，字段名与 omp 的解析器对齐。 */
interface SearxngResult {
  title: string;
  url: string;
  content: string;
  engine: string;
}

/** SearXNG 兼容响应。`unresponsive_engines` 是 `[engine, reason]` 元组数组。 */
interface SearxngResponse {
  query: string;
  number_of_results: number;
  results: SearxngResult[];
  answers: string[];
  unresponsive_engines: Array<[string, string]>;
}

/** token 文件位置。与配置分离：配置会被复制备份，秘密不该跟着走。 */
export function serveTokenPath(): string {
  return path.join(os.homedir(), '.searchfuse', 'serve-token');
}

/** 运行时文件：谁在跑、什么时候起的。不含端口（固定端口）。 */
export function runtimePath(): string {
  return path.join(os.homedir(), '.searchfuse', 'runtime.json');
}

/** 读 token；没有就生成一个并写盘（POSIX 上用 0600）。 */
export function ensureServeToken(): string {
  const file = serveTokenPath();
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing !== '') return existing;
  } catch {
    // 不存在：往下生成。
  }
  const token = randomToken();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    // Windows 上 chmod 静默无效；POSIX 上再确认一次。
    fs.chmodSync(file, 0o600);
  } catch {
    // 忽略：权限是加固，不是正确性前提。
  }
  return token;
}

/** 32 字节随机 token 的十六进制形式。 */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 把一次聚合结果翻译成 SearXNG 的形状。
 *
 * 三条规则：
 * - `title` / `url` / `content` 直对，缺 `url` 的条目丢弃（omp 需要它）
 * - `engine` 填作答的引擎名，不是 `searxng`——它本来就是别的东西
 * - **`unresponsive_engines` 必须带上**：omp 靠它在结果为空时保真上游原因，
 *   缺了它只会退化成一句泛化错误
 */
export function toSearxngShape(raw: unknown, query: string): SearxngResponse {
  const root = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const results = Array.isArray(root.results) ? root.results : [];
  const entry = typeof results[0] === 'object' && results[0] !== null ? (results[0] as Record<string, unknown>) : {};

  const items = Array.isArray(entry.items) ? entry.items : [];
  const mapped: SearxngResult[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : undefined;
    if (!url) continue;
    const title = typeof record.title === 'string' ? record.title : url;
    const content =
      typeof record.snippet === 'string'
        ? record.snippet
        : typeof record.summary === 'string'
          ? record.summary
          : '';
    mapped.push({ title, url, content, engine: typeof entry.engine === 'string' ? entry.engine : 'searchfuse' });
  }

  // 失败的引擎：omp 只在结果为空时读它，但我们总是填，让诊断信息不丢。
  const failures: Array<[string, string]> = [];
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  for (const attempt of attempts) {
    if (typeof attempt !== 'object' || attempt === null) continue;
    const record = attempt as Record<string, unknown>;
    if (typeof record.error !== 'string') continue;
    failures.push([typeof record.engine === 'string' ? record.engine : 'unknown', record.error]);
  }

  const answer = typeof entry.summary === 'string' && entry.summary !== '' ? [entry.summary] : [];

  return {
    query,
    number_of_results: mapped.length,
    results: mapped,
    answers: answer,
    unresponsive_engines: failures,
  };
}

/** `config.engines` 里启用中的引擎名，供 `/config` 的壳使用。 */
function enabledEngines(): Array<{ name: string; shortcut?: string }> {
  const config = loadConfigFile(currentConfigPath());
  const engines = config.engines ?? {};
  return Object.entries(engines)
    .filter(([, settings]) => settings.enabled !== false)
    .map(([name]) => ({ name }));
}

/** 常量的响应头。`no-store`：这是搜索，不该被任何中间层缓存。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** 从请求里取 bearer token，大小写不敏感。 */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export interface ServeOptions {
  port: number;
  token: string;
  /** 空闲多少秒后退出。0 表示不退出。 */
  idleExitSeconds: number;
  /** 测试用：注入的搜索函数，默认走 runSearch。 */
  search?: typeof runSearch;
}

export interface ServeHandle {
  server: http.Server;
  port: number;
  /** `/search` 成功应答的次数。S5 的验收依赖它。 */
  localHits(): number;
  close(): Promise<void>;
}

/**
 * 起服务。固定端口——被占用就报错，不漂移。
 *
 * 为什么不漂移：omp 的 `searxng.endpoint` 是配置文件里的静态字符串，
 * 端口变了它不会跟着变，于是每次重启都要用户手动跑一次 `hosts sync`。
 * 固定端口把这条高频故障变成一次性配置。
 */
export function startServe(options: ServeOptions): Promise<ServeHandle> {
  const search = options.search ?? runSearch;
  let hits = 0;
  let inFlight = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);

    // `/healthz` 免鉴权：就绪探测要能区分「起来了」与「起来了但要授权」。
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('OK');
      return;
    }

    if (bearerOf(req.headers.authorization) !== options.token) {
      res.writeHead(401, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url.pathname === '/__stats') {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ localHits: hits }));
      return;
    }

    if (url.pathname === '/config') {
      // omp 只在设置了 `searxng.engines` 时请求它，用来解析引擎快捷名。
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ engines: enabledEngines() }));
      return;
    }

    // ── 三宿主共用的完整端点 ─────────────────────────────────────
    //
    // `/search` 是给 omp 的 SearXNG 壳；下面这两个是给 dsh / Claude Code /
    // omp 扩展的**原生形状**：它们要的是 RunSearchResult（含 attempts、
    // durationSeconds、summary），而不是被压扁成 SearXNG 的样子。
    if (url.pathname === '/v1/search' || url.pathname === '/v1/read-page') {
      inFlight += 1;
      scheduleIdleExit();
      const config = loadConfigFile(currentConfigPath());
      const isReadPage = url.pathname === '/v1/read-page';
      const query = url.searchParams.get('q') ?? '';
      const targetUrl = url.searchParams.get('url') ?? '';
      if (isReadPage && targetUrl === '') {
        inFlight -= 1;
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'missing url' }));
        return;
      }
      if (!isReadPage && query === '') {
        inFlight -= 1;
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'missing q' }));
        return;
      }
      const options = isReadPage
        ? {
            url: targetUrl,
            allowPrivateNetwork: allowsPrivateNetwork(config),
            config,
          }
        : {
            query,
            sources: url.searchParams.get('source') ?? 'web',
            maxResults: Number(url.searchParams.get('max') ?? '') || undefined,
            allowPrivateNetwork: allowsPrivateNetwork(config),
            config,
          };
      void search(options as Parameters<typeof search>[0])
        .then((result) => {
          if (result.results.some((entry) => entry.status !== 'unavailable')) hits += 1;
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(result));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: message }));
        })
        .finally(() => {
          inFlight -= 1;
          scheduleIdleExit();
        });
      return;
    }

    if (url.pathname === '/search') {
      const query = url.searchParams.get('q') ?? '';
      inFlight += 1;
      scheduleIdleExit();
      const config = loadConfigFile(currentConfigPath());
      void search({
        query,
        sources: 'web',
        allowPrivateNetwork: allowsPrivateNetwork(config),
        config,
      })
        .then((result) => {
          const payload = toSearxngShape(result, query);
          if (payload.results.length > 0) hits += 1;
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(payload));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: message, results: [], answers: [], unresponsive_engines: [] }));
        })
        .finally(() => {
          inFlight -= 1;
          scheduleIdleExit();
        });
      return;
    }

    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
  });

  /** 空闲退出：**只统计空闲**，在途请求期间绝不退出。 */
  function scheduleIdleExit(): void {
    if (options.idleExitSeconds <= 0) return;
    clearTimeout(idleTimer);
    if (inFlight > 0) return;
    // 再等 2 秒确认真的没有新请求进来，避免与刚到的请求撞车。
    idleTimer = setTimeout(() => {
      if (inFlight > 0) return;
      void close();
    }, options.idleExitSeconds * 1000 + 2000);
    idleTimer.unref();
  }

  async function close(): Promise<void> {
    clearTimeout(idleTimer);
    try {
      fs.rmSync(runtimePath(), { force: true });
    } catch {
      // 运行时文件删不掉不影响关闭。
    }
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }

  const ready = Promise.withResolvers<ServeHandle>();
  server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        ready.reject(
          new Error(
            `Port ${options.port} is already in use. The service does not switch ports: ` +
              'omp holds a static endpoint, so a moved port would silently break it. ' +
              'Stop whatever holds the port, or run `searchfuse serve --port <other>` and update your host configs.',
          ),
        );
        return;
      }
      ready.reject(error);
  });

  server.listen(options.port, '127.0.0.1', () => {
    // 端口 0 时内核会分配一个真实端口，必须从 address() 取回，
    // 否则调用方拿着 0 去连接会 EADDRNOTAVAIL。
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;

    // 就绪后写运行时文件，退出时删除（见 close）。
    //
    // **必须带端口**：宿主侧的客户端（Claude Code 用 `$.http.fetch`）只有
    // 读了这里才知道该连哪。固定端口写死的话，一旦端口被占就没法降级到
    // 一个空闲端口。
    try {
      fs.mkdirSync(path.dirname(runtimePath()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        runtimePath(),
        `${JSON.stringify({ port: boundPort, pid: process.pid, startedAt: new Date().toISOString(), version: __APP_VERSION__, token: options.token }, null, 2)}\n`,
      );
    } catch {
      // 运行时文件是诊断用的，写不了不影响服务本身。
    }
    scheduleIdleExit();
    ready.resolve({ server, port: boundPort, localHits: () => hits, close });
  });
  return ready.promise;
}

declare const __APP_VERSION__: string;
