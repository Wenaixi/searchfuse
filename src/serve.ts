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
import { identityOf } from './serveIdentity.ts';

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

/** 运行时文件：谁在跑、端口、指纹、token。客户端优先读它；它不在时按候选探测。 */
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
  //
  // 两个来源都要读，因为两种运行模式的失败信息放在不同字段里：
  // - 链式：失败写在 `attempts` 的 `error` 上
  // - 融合：`buildFusedResult` 返回 `attempts: []`，失败全在 `uncertainty`
  //   （形如 "tavily: 超时" 的一行行文字），`status` 同时变成 degraded
  //
  // 只读 `attempts` 的话，融合模式下这份失败列表永远是空的——omp 拿不到任何
  // 上游原因，只剩一句泛化错误，那正是这个字段存在的理由。
  const failures: Array<[string, string]> = [];
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  for (const attempt of attempts) {
    if (typeof attempt !== 'object' || attempt === null) continue;
    const record = attempt as Record<string, unknown>;
    if (typeof record.error !== 'string') continue;
    failures.push([typeof record.engine === 'string' ? record.engine : 'unknown', record.error]);
  }
  // 融合模式的补充：uncertainty 里每一条是「引擎: 原因」这样的整行文字，
  // 拆成 omp 要的 [engine, reason] 二元组。拆不出引擎名的整行保留成一条，
  // 宁可多一条也不要丢掉原因。
  if (failures.length === 0) {
    const uncertainty = Array.isArray(entry.uncertainty) ? entry.uncertainty : [];
    for (const line of uncertainty) {
      if (typeof line !== 'string' || line === '') continue;
      const colon = line.indexOf(':');
      if (colon > 0 && colon < 40) {
        failures.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
      } else {
        failures.push(['searchfuse', line]);
      }
    }
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
  /**
   * 状态目录指纹。`/healthz` 把它交出去，客户端据此确认应答者是「同一个
   * `.searchfuse`」的服务。缺省时按当前 home 推导，测试可显式覆盖。
   */
  fingerprint?: string;
  /**
   * 候选端口。给定时服务按顺序找第一个能绑的，全部被占才报错。
   *
   * 为什么需要：原先 `serve.port` 默认 0（内核随机挑），于是并发起的多个
   * 实例各绑各的端口、全部成功、全部常驻，谁最后写 runtime.json 谁赢。
   * 确定性候选把这个雪崩变成「第一个抢到，其余发现它已健康就退出」。
   */
  candidatePorts?: number[];
}

export interface ServeHandle {
  server: http.Server;
  port: number;
  /** `/search` 成功应答的次数。S5 的验收依赖它。 */
  localHits(): number;
  close(): Promise<void>;
}

/**
/**
 * 起服务。按候选端口顺序找第一个能绑的，全部被占才报错。
 *
 * 为什么是确定性候选而不是让内核随机分配：端口随机时 runtime.json 会成为
 * 唯一线索，而它会在服务被 kill 时消失（close 跑不到）。候选来自目录指纹，
 * 同一份 `.searchfuse` 永远得到同一组，客户端不必依赖文件也能找到服务。
 *
 * 为什么不漂移到任意空闲端口：8 个候选都被占说明同机上真有 8 个实例，
 * 那时报错比再挑一个用户不知道的端口更有用——后者会让诊断无处下手。
 */
export function startServe(options: ServeOptions): Promise<ServeHandle> {
  const search = options.search ?? runSearch;
  const fingerprint = options.fingerprint ?? identityOf(os.homedir()).fingerprint;
  // `__APP_VERSION__` 是 vite 构建时注入的常量，在直接跑 TS 源码的场景
  // （测试、`tsx`）里不存在。**必须只守卫一次、两处共用**：早先 `/identity`
  // 用 typeof 守卫而 runtime.json 写入处裸用，于是裸跑时服务能起、`/identity`
  // 能答，但 runtime.json 写入抛 ReferenceError 被 catch 吞掉——文件永远写
  // 不出，serveEnsure 卡在「runtime.json not written」那个分支。
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  let hits = 0;
  let inFlight = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  /** 实际绑定的端口。listen 回调里才有值，`/healthz` 要把它报出去。 */
  let boundPortForHealth = options.port;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);

    // `/healthz` 免鉴权：就绪探测要能区分「起来了」与「起来了但要授权」。
    //
    // **body 必须保持纯文本 `OK`**：现存的四个消费者（main.ts 的 --ensure、
    // dsh 的唤醒轮询、claude hook 的探测、serveEnsure.ts）都只看状态码，
    // 但把 body 换成 JSON 是无谓的破坏性变更。身份校验走下面单独的
    // `/identity` 端点。
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('OK');
      return;
    }

    // `/identity` 免鉴权：只回身份，不泄露 token 与配置。
    //
    // 客户端按目录推导出候选端口后逐个探测，靠这里的 fingerprint 确认应答者
    // 确实是同一份 `.searchfuse` 的服务，而不是恰好占着那个端口的别的程序。
    //
    // `/identity` 免鉴权：只回身份，不泄露 token 与配置。
    //
    // 客户端按目录推导出候选端口后逐个探测，靠这里的 fingerprint 确认应答者
    // 确实是同一份 `.searchfuse` 的服务，而不是恰好占着那个端口的别的程序。
    if (url.pathname === '/identity') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ port: boundPortForHealth, pid: process.pid, fingerprint, version }));
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
            // 客户端带过来的预算：插件按自己的宿主预算计算，配置里的
            // aggregate.deadlineMs 也经这里下发。不传就退回服务端默认值，
            // 于是这些设置不会变成哑设置。
            timeoutMs: Number(url.searchParams.get('timeout') ?? '') || undefined,
            deadlineMs: Number(url.searchParams.get('deadline') ?? '') || undefined,
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
    // **只删属于自己的那份 runtime.json。**
    //
    // 早先这里无条件 `rmSync`。问题在于：先起的服务 A 关闭时，会把后起的
    // 服务 B 写下的文件一并删掉，B 于是瞬间变瞎（服务在听、文件没了）。
    // 改成先读回 pid，确认是自己写的再删。
    try {
      const raw = fs.readFileSync(runtimePath(), 'utf-8');
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === 'number' && parsed.pid === process.pid) {
        fs.rmSync(runtimePath(), { force: true });
      }
    } catch {
      // 文件不在或读不了：没有可删的，或者那是别人的。两种情况都不动手。
    }
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }

  const ready = Promise.withResolvers<ServeHandle>();

  /**
   * 依次尝试候选端口的监听器。
   *
   * 候选来自目录指纹，同一份 `.searchfuse` 永远得到同一组，所以「谁先来谁
   * 占住前面的」。全部被占才报错——那时说明同机上真有 8 个实例，比让内核
   * 随机分配一个用户不知道的端口要好：后两者会让 runtime.json 成为唯一线索。
   */
  const portQueue = options.candidatePorts !== undefined && options.candidatePorts.length > 0
    ? [...options.candidatePorts]
    : [options.port];
  /** 已经尝试过的端口，用来在报错时把「试过哪些」完整说出来。 */
  const triedPorts: number[] = [];

  const tryListenNext = (): void => {
    const port = portQueue.shift();
    if (port === undefined) {
      ready.reject(
        new Error(
          `No candidate port was usable (tried ${triedPorts.join(', ')}). ` +
            'Stop another searchfuse instance, or set serve.port to a free number.',
        ),
      );
      return;
    }
    triedPorts.push(port);
    server.listen(port, '127.0.0.1');
  };

  server.on('error', (error: NodeJS.ErrnoException) => {
    // 端口相关的错误都换下一个候选，不只是 EADDRINUSE：
    // EACCES（端口被系统保留或权限不足）同样不该让整次启动失败——候选
    // 有 8 个，换一个通常就能绑上。
    //
    // 其它错误（例如 ENOMEM）是环境问题，换端口也无济于事，直接报出来。
    const portLevel = error.code === 'EADDRINUSE' || error.code === 'EACCES';
    if (portLevel && portQueue.length > 0) {
      tryListenNext();
      return;
    }
    if (portLevel) {
      ready.reject(
        new Error(
          `Port ${options.port} could not be bound (${error.code}). Leave serve.port at 0 so ` +
            'searchfuse can pick a deterministic candidate derived from your ~/.searchfuse directory.',
        ),
      );
      return;
    }
    ready.reject(error);
  });

  // 用 `once`：候选重试时如果前一个端口的 listening 已经触发过，
  // 再触发一次会重复写 runtime.json（后写的覆盖先写的，而 pid 相同，
  // 关掉时只删一次，看似无害，但绑定端口会以最后一次为准，与 ready
  // 已经 resolve 的那次不一致）。
  server.once('listening', () => {
    // 端口 0 时内核会分配一个真实端口，必须从 address() 取回，
    // 否则调用方拿着 0 去连接会 EADDRNOTAVAIL。
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;
    boundPortForHealth = boundPort;

    // 就绪后写运行时文件，退出时删除（见 close）。
    //
    // **必须带指纹**：客户端按目录推导候选端口时，靠它确认应答者是同一份
    // 状态目录的服务，而不是恰好占着那个端口的别的程序。
    try {
      fs.mkdirSync(path.dirname(runtimePath()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        runtimePath(),
        `${JSON.stringify({ port: boundPort, pid: process.pid, fingerprint, startedAt: new Date().toISOString(), version, token: options.token }, null, 2)}\n`,
      );
    } catch {
      // 运行时文件是诊断用的，写不了不影响服务本身。
    }
    scheduleIdleExit();
    ready.resolve({ server, port: boundPort, localHits: () => hits, close });
  });

  tryListenNext();
  return ready.promise;
}

declare const __APP_VERSION__: string;
