# 本地服务生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Claude Code 侧在本地服务不可用时能自己拉起来，并把「服务在不在」这一个判据统一到单处。

**Architecture:** 抽一个 `ensureServeRunning()` 放在 `src/serveEnsure.ts`，复用现成的 `serve --ensure` 幂等语义。dsh 的两个入口**不能** import `src/`（编译边界，已实测），所以 `dsh/index.ts` 自足实现同构的一份，与既有的 `claudeHostStatus` / `ompHostStatus` 同一个模式。Claude 的 hook 沙箱没有 `process`，它走自己已有的 `$.process.run` 跑同一条命令。两份实现的**行为**必须逐条对齐，验收时两边都要验。

**Tech Stack:** TypeScript（strict）、Node 内置 `node:http` / `node:child_process` / `node:fs`、vitest 3.2.4

**Spec:** `docs/superpowers/specs/2026-11-24-serve-lifecycle-design.md`

## Global Constraints

- 两个 tsconfig 必须都保持 0 错误：`npx tsc --noEmit`（src 含测试）与 `npx tsc -p tsconfig.dsh.json --noEmit`（`dsh/index.ts`、`dsh/client.ts`）。
- 改了 `dsh/*.ts` 必须 `npx tsc -p tsconfig.dsh.json --outDir dsh` 重新编译，否则宿主读的是旧产物。
- 所有注释与文档用简体中文，不使用 emoji。
- 文档注释不写空洞排比、夸张宣传、没有信息量的总结。
- 不新增任何依赖。
- 探本地端口必须一次只探一个，给足超时，且看毫秒数——同批探针会把慢的误判成超时。
- 提交消息用 `python -I -c` 写入 `.git-commit-msg.tmp`（已在 `.gitignore` 里），再用 `git commit -F`。不要用 PowerShell here-string。
- 每完成一个任务立刻 commit。

---

### Task 1: `ensureServeRunning` 的判据与拉起

**Files:**
- Create: `src/serveEnsure.ts`
- Test: `src/serveEnsure.test.ts`

**Interfaces:**
- Consumes: `runtimePath()` 从 `src/serve.ts:51` 导入。
- Produces:
  ```ts
  export interface EnsureOutcome {
    started: boolean;
    port?: number;
    reason?: string;
  }
  export interface EnsureOptions {
    /** 拉起子进程的 node 可执行文件；默认按 PATH 解析裸名 'node'。 */
    nodeBinary?: string;
    /** CLI 入口的绝对路径；默认从本文件位置推 ../dist/main.js。 */
    cliPath?: string;
    /** spawn 到退出码返回的上限，默认 20 秒。 */
    timeoutMs?: number;
  }
  export function ensureServeRunning(options?: EnsureOptions): Promise<EnsureOutcome>;
  export function readServeRuntimeFile(file?: string): { port: number; token: string } | undefined;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// src/serveEnsure.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServeRunning, readServeRuntimeFile } from './serveEnsure.ts';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个临时 runtime.json，用完删掉。 */
function tempRuntime(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-ensure-'));
  created.push(dir);
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify(contents), 'utf-8');
  return file;
}

describe('readServeRuntimeFile', () => {
  it('读回端口与 token', () => {
    const file = tempRuntime({ port: 61746, token: 'abc' });
    expect(readServeRuntimeFile(file)).toEqual({ port: 61746, token: 'abc' });
  });

  it('文件不存在时返回 undefined，不抛异常', () => {
    expect(readServeRuntimeFile('/nonexistent/runtime.json')).toBeUndefined();
  });

  it('形状不对时返回 undefined', () => {
    const file = tempRuntime({ port: 'not a number', token: 'abc' });
    expect(readServeRuntimeFile(file)).toBeUndefined();
  });
});

describe('ensureServeRunning', () => {
  it('服务已在跑时不动文件、不 spawn', async () => {
    const file = tempRuntime({ port: 61746, token: 'abc' });
    const before = fs.statSync(file).mtimeMs;
    // 61746 上没有服务，所以这条走 spawn。用一个必然失败的 CLI 让 spawn 立刻返回，
    // 从而只验「没有改写 runtime.json」这一件事。
    const outcome = await ensureServeRunning({
      cliPath: '/nonexistent/main.js',
      timeoutMs: 500,
    });
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(outcome.started).toBe(false);
    expect(typeof outcome.reason).toBe('string');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/serveEnsure.test.ts`
Expected: FAIL —— `Failed to resolve import "./serveEnsure.ts"`

- [ ] **Step 3: 实现**

```ts
// src/serveEnsure.ts
import { spawn } from 'node:child_process';
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
 *
 * **不能等子进程退出码（2026-11-24 实测）。** `serve --ensure` 在服务不在跑时
 * 会常驻不退出（`src/main.ts:326-333` 只写 stdout，没有 exit），所以等退出码
 * 永远等不到；超时到点杀掉子进程，杀掉的正是刚起来的服务。改为 spawn 后
 * 轮询 `/healthz`，子进程 detached 且不 kill。
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

  const spawned = await new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(nodeBinary, [cliPath, 'serve', '--ensure'], {
        stdio: 'ignore',
        windowsHide: true,
        // 它是常驻服务，不能跟着调用方的生命周期走。
        detached: true,
      });
    } catch {
      resolve(false);
      return;
    }
    // 不 kill、不等 close：它本来就不该退出。只处理起不来（如 node 不在 PATH）。
    child.on('error', () => resolve(false));
    child.unref();
    resolve(true);
  });
  if (!spawned) return { started: false, reason: 'could not start the serve process' };

  // 轮询到通为止。500ms 一次，总上限与 spawn 超时同一个数。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = readServeRuntimeFile(file);
    if (probe !== undefined && (await healthOnce(probe.port))) {
      return { started: true, port: probe.port };
    }
  }
  return { started: false, reason: `serve did not become healthy within ${timeoutMs} ms` };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/serveEnsure.test.ts`
Expected: PASS，4 条全绿

- [ ] **Step 5: 类型检查与提交**

```bash
npx tsc --noEmit
python -I -c "import io; io.open('.git-commit-msg.tmp','w',encoding='utf-8',newline='\n').write('新增 ensureServeRunning：本地服务的唯一判据\n\n复用 serve --ensure 的幂等语义，先探 runtime.json 与 /healthz，\n服务真的不在才 spawn。文件在但服务已死是最阴的状态，直接 spawn 会撞上\n仍被占用的端口，所以顺序不能倒过来。\n')"
git add src/serveEnsure.ts src/serveEnsure.test.ts .git-commit-msg.tmp
git commit -F .git-commit-msg.tmp
rm -f .git-commit-msg.tmp
```

---

### Task 2: dsh 侧接入——摘要、动作、启动拉起

**Files:**
- Modify: `dsh/index.ts`（`engineSummary` 加 `serve` 段；`registerConfigRoute` 加动作分支；`apply` 末尾非阻塞拉起）
- Test: `src/dshPlugin.test.ts`

**注意：** 前端的服务状态行与「拉起」按钮属于 **Task 3**，本任务**不碰** `dsh/client.ts`。

**Interfaces:**
- Consumes: Task 1 的行为语义，但**不 import 它的模块**——见下方关键约束。
- Produces:
  - `engineSummary()` 新增字段 `serve: { running: boolean; port?: number }`
  - `POST /searchfuse/config` 接受 `{ "action": "ensureServe" }`，返回 `{ ok: boolean; port?: number; message?: string }`

**关键约束（2026-11-24 实测）：`dsh/*.ts` 不能 import `src/`。**

`tsconfig.dsh.json` 的 `files` 只有两个入口，且 `src/` 用的是 `.ts` 扩展名导入
（`import './config.ts'`）。一旦 `dsh/index.ts` 去 import `src/serveEnsure.ts`，
TypeScript 会顺着依赖树把整个 `src/` 拉进这次编译，于是满屏 `TS5097`
（`allowImportingTsExtensions` 未开启）。实测报错第一条是
`dsh/index.ts(29,29): error TS5097`，随后是 `src/aggregate/rrf.ts`、`src/config.ts` 等。

所以 dsh 侧**自足实现**判据，与既有的 `claudeHostStatus` / `ompHostStatus`
完全同一个模式：`dsh/index.ts` 已经有一整套「自己读文件、自己比对」的实现，
它们也没有 import `src/`。这不是重复，是编译边界决定的。

代价是判据有两份实现（`src/serveEnsure.ts` 一份、`dsh/index.ts` 一份），
所以两边的**行为必须逐条对齐**，Task 5 的验收里要同时验两边。

- [ ] **Step 1: 写失败的测试**

追加到 `src/dshPlugin.test.ts`：

```ts
describe('本地服务状态与手动拉起', () => {
  it('摘要里带上服务在不在', async () => {
    const summary = await callConfigRoute({ method: 'GET' });
    expect(summary).toHaveProperty('serve');
    expect(typeof summary.serve.running).toBe('boolean');
  });

  it('POST action=ensureServe 返回端口', async () => {
    const result = await callConfigRoute({
      method: 'POST',
      body: JSON.stringify({ action: 'ensureServe' }),
      contentType: 'application/json',
    });
    expect(result.ok).toBe(true);
    expect(typeof result.port).toBe('number');
  });
});
```

**注意：** `callConfigRoute` 需要按 `CLAUDE.md` 里的最小夹具写，`res` 必须有 `writeHead` 与 `end`。若测试文件里已有同名辅助函数，直接复用，不要新建第二个。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dshPlugin.test.ts`
Expected: FAIL —— `expected undefined to be a boolean`（`serve` 段还不存在）

- [ ] **Step 3: 实现 `engineSummary` 的 `serve` 段**

在 `dsh/index.ts` 的 `engineSummary()` 返回对象里，紧邻 `hosts: hostStatuses(config)` 加：

```ts
      serve: await serveStatus(),
```

新增函数，紧邻 `hostStatuses` 之后。**注意：它自己读文件、自己探端口，不 import `src/`。**

```ts
/** `~/.searchfuse/runtime.json` 里我们关心的两字段。 */
interface ServeRuntimeFile {
  port: number;
  token: string;
}

/**
 * 读 runtime.json。形状严格：端口不是整数就当没有——宁可多拉起一次，
 * 也不要拿一个坏端口去连。
 */
function readServeRuntime(): ServeRuntimeFile | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.searchfuse', 'runtime.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port)) return undefined;
    if (typeof parsed.token !== 'string' || parsed.token === '') return undefined;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return undefined;
  }
}

/**
 * 本地服务在不在。
 *
 * 判据与 `src/serveEnsure.ts` 的 `ensureServeRunning` 前两步完全相同：读
 * runtime.json、探 /healthz。两份实现在编译边界上互不相通（dsh 的两个入口
 * 不能 import src），所以行为必须逐条对齐，改一处时另一处要跟着改。
 *
 * 探不通时只报 `running: false`，不报原因：卡片要的是一个状态。
 */
async function serveStatus(): Promise<{ running: boolean; port?: number }> {
  const existing = readServeRuntime();
  if (existing === undefined) return { running: false };
  try {
    const res = await fetch(`http://127.0.0.1:${existing.port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? { running: true, port: existing.port } : { running: false };
  } catch {
    return { running: false };
  }
}

/**
 * 拉起本地服务：跑 `serve --ensure`。它已在跑就 exit 0，所以重复调用安全。
 *
 * CLI 路径从 `PACKAGE_ROOT` 推，不假设与源码树同构——插件在 pnpm 的快照里
 * 运行时，`../dist/main.js` 指向的是快照内的副本，那正是我们要用的那份。
 *
 * **不能等子进程退出码（2026-11-24 实测）。** 服务不在跑时 `serve --ensure`
 * 常驻不退出，等退出码永远等不到，超时杀掉反而是刚起来的服务。它与
 * `src/serveEnsure.ts` 的 `ensureServeRunning` 是同一个模型，改一处必须改另一处。
 */
async function startServe(): Promise<{ started: boolean; port?: number; reason?: string }> {
  const cliPath = join(PACKAGE_ROOT, 'dist', 'main.js');
  const spawned = await new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawnHidden('node', [cliPath, 'serve', '--ensure'], {
        stdio: 'ignore',
        detached: true,
      });
    } catch {
      resolve(false);
      return;
    }
    // 不 kill、不等 close：它本来就不该退出。
    child.on('error', () => resolve(false));
    child.unref();
    resolve(true);
  });
  if (!spawned) return { started: false, reason: 'could not start the serve process' };

  const deadline = Date.now() + SERVE_ENSURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = readServeRuntime();
    if (probe !== undefined && (await healthOnce(probe.port))) {
      return { started: true, port: probe.port };
    }
  }
  return { started: false, reason: `serve did not become healthy within ${SERVE_ENSURE_TIMEOUT_MS} ms` };
}

/** 探一次 /healthz。返回是否 200。与 `src/serveEnsure.ts` 的同名逻辑一致。 */
function healthOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/healthz',
        method: 'GET',
        timeout: 2000,
        // 探针必须主动断开，否则会等 keep-alive 超时。
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
```

`httpRequest` 需要从 `node:http` 导入（`dsh/index.ts` 顶部若还没有 `import { request as httpRequest } from 'node:http'` 就加上）。

新增常量，紧邻已有的 `CLI_PATH` 声明：

```ts
/** 拉起服务的上限。与 omp 扩展侧的 WAKE_TIMEOUT_MS 保持一致。 */
const SERVE_ENSURE_TIMEOUT_MS = 20_000;
```

`spawnHidden` 已在文件顶部导入（`dsh/index.ts:28`），不需要新增导入。

- [ ] **Step 4: 实现路由动作**

在 `registerConfigRoute` 的 POST 分支里，`applyCardSettings` 调用之前插入：

```ts
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Bag;
        // 独立动作，不走 applyCardSettings：它是一次会 spawn 子进程的副作用，
        // 而 applyCardSettings 的契约是「只写配置文件的那些段」。
        if (body?.action === 'ensureServe') {
          const outcome = await startServe();
          send(200, {
            ok: outcome.started || outcome.port !== undefined,
            ...(outcome.port === undefined ? {} : { port: outcome.port }),
            ...(outcome.reason === undefined ? {} : { message: outcome.reason }),
          });
          return;
        }
        applyCardSettings(body);
```

**注意：** 原来的代码是 `applyCardSettings(JSON.parse(...))`，要把它改成先解析到 `body`、再传递。

- [ ] **Step 5: （已作废）不实现「apply 末尾自动拉起」**

**实施时推翻：** 原计划要在 `apply()` 末尾 `void startServe()`。实测它会把
`dsh web search provider` 与 `dsh CLI budgets` 两组共 5 条既有测试打下线——
那些用例断言「发到服务的请求恰好 1 个、首个 path 是 `/v1/search`」，而 `apply`
时的 healthz 探针把计数变成 2、把首个请求变成 `/healthz`。

而且它本来就违反三条：拖慢每次插件加载、dsh 自己走 CLI 根本不需要服务、
用户没在用服务时也白起一个常驻进程。

**所以 dsh 侧只在卡片的「拉起」动作（Step 4）里真的 spawn。** 不减少任何
实际能力：需要服务的另外两个宿主各有自己的 ensure。这一步没有代码要写。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/dshPlugin.test.ts`
Expected: PASS，含新增 2 条

- [ ] **Step 7: 编译并提交**

```bash
npx tsc -p tsconfig.dsh.json --outDir dsh
npx tsc --noEmit
python -I -c "import io; io.open('.git-commit-msg.tmp','w',encoding='utf-8',newline='\n').write('dsh 侧接入服务生命周期：摘要报状态、路由可手动拉起、启动时非阻塞拉起\n\n摘要里的 serve 段与 ensureServeRunning 用同一套判据，避免两处得出两种答案。\n拉起是独立动作而不是配置补丁：它会 spawn 子进程，不属于「只写配置文件」。\n启动时的拉起不阻塞 apply，失败只记一行日志。\n')"
git add dsh/index.js dsh/index.ts src/dshPlugin.test.ts .git-commit-msg.tmp
git commit -F .git-commit-msg.tmp
rm -f .git-commit-msg.tmp
```

---

### Task 3: 卡片上的服务状态与拉起按钮

**Files:**
- Modify: `dsh/client.ts`
- Test: `src/dshClient.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `summary.serve` 与 `POST {action:'ensureServe'}`
- Produces: `__card.serveLabel(summary)` 纯函数，返回 `'running' | 'stopped' | 'unknown'`

- [ ] **Step 1: 写失败的测试**

追加到 `src/dshClient.test.ts`：

```ts
describe('服务状态行', () => {
  it('服务在跑时报 running', () => {
    expect(card.serveLabel({ serve: { running: true, port: 61746 } })).toBe('running');
  });

  it('服务不在时报 stopped', () => {
    expect(card.serveLabel({ serve: { running: false } })).toBe('stopped');
  });

  it('旧版摘要没有 serve 段时报 unknown，而不是假装不在', () => {
    expect(card.serveLabel({})).toBe('unknown');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dshClient.test.ts`
Expected: FAIL —— `card.serveLabel is not a function`

- [ ] **Step 3: 实现纯函数**

在 `dsh/client.ts` 里，紧邻 `searxngModeOf` 之后：

```ts
    /**
     * 服务状态的三态。
     *
     * 旧版摘要没有 `serve` 段时返回 'unknown' 而不是 'stopped'：把「不知道」
     * 报成「没在跑」会导致卡片一直挂着拉起按钮，而那可能是一次误报。
     */
    function serveLabel(summary: Bag): string {
      var serve = summary?.serve;
      if (serve === undefined || serve === null) return 'unknown';
      return serve.running === true ? 'running' : 'stopped';
    }
```

并加进 `exports.__card` 列表：

```ts
      serveLabel: serveLabel,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dshClient.test.ts`
Expected: PASS

- [ ] **Step 5: 渲染状态行与按钮**

在卡片列表之前（与聚合/退避模式同一层）加一段。文案必须同时进 `TEXT.en` 与 `TEXT.zh`：

```ts
        serveSection: 'Local service',
        serveRunning: 'Running on port {port}',
        serveStopped: 'Not running',
        serveUnknown: 'Status unknown',
        serveStart: 'Start it',
        serveStartHint: 'Starts the shared search service. Other harnesses will use it too.',
```

```ts
        serveSection: '本地服务',
        serveRunning: '运行中，端口 {port}',
        serveStopped: '未运行',
        serveUnknown: '状态未知',
        serveStart: '拉起',
        serveStartHint: '拉起后，其他宿主的搜索也会走这个服务。',
```

渲染逻辑：`serveLabel(summary) !== 'running'` 时才显示按钮；点击 POST `{action:'ensureServe'}`。按钮点击后重新拉一次 summary（复用现有的 refresh 调用）。

**注意：** 卡片上不允许出现 `title` 属性（既有的样式门禁守着这一条）。提示文案用可见的说明行，不用 tooltip。

- [ ] **Step 6: 跑样式门禁与测试**

Run: `npx vitest run src/dshClient.test.ts`
Expected: PASS，含既有的 CSS token 门禁

- [ ] **Step 7: 编译并提交**

```bash
npx tsc -p tsconfig.dsh.json --outDir dsh
python -I -c "import io; io.open('.git-commit-msg.tmp','w',encoding='utf-8',newline='\n').write('卡片显示本地服务状态，并提供手动拉起\n\n三态而不是两态：旧版摘要没有 serve 段时报 unknown，把「不知道」当成\n「没在跑」会让卡片一直挂着按钮。文案中英各一套。\n')"
git add dsh/client.js dsh/client.ts src/dshClient.test.ts .git-commit-msg.tmp
git commit -F .git-commit-msg.tmp
rm -f .git-commit-msg.tmp
```

---

### Task 4: Claude hook 的第三级兜底

**Files:**
- Modify: `claude/hooks/register.ts`
- Test: `src/hosts.test.ts`（加一个纯函数的路径推导测试）

**Interfaces:**
- Consumes: `searchfuseHosts.claudeCode.kernelPath`（settings 里已有的绝对路径）
- Produces: `serveCliPathFromKernel(kernelPath)` 导出，返回同目录下的 `main.js`

**关键约束：** hook 沙箱里 `globalThis.process` 是 undefined，**不能** import `src/serveEnsure.ts`（它依赖 `node:child_process` 的模块级导入）。Claude 侧只能走 `$.process.run`。

- [ ] **Step 1: 写失败的测试**

追加到 `src/hosts.test.ts`：

```ts
describe('serveCliPathFromKernel', () => {
  it('从 kernel.js 推出同目录的 main.js', () => {
    expect(serveCliPathFromKernel('E:\\x\\dist\\kernel.js')).toBe('E:\\x\\dist\\main.js');
  });

  it('路径里没有 kernel.js 时返回 undefined，不乱猜', () => {
    expect(serveCliPathFromKernel('E:\\x\\dist\\other.js')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/hosts.test.ts`
Expected: FAIL —— `serveCliPathFromKernel is not a function`

- [ ] **Step 3: 实现路径推导**

在 `src/hosts.ts` 里导出：

```ts
/**
 * 从 kernel 的绝对路径推出同目录下的 CLI 入口。
 *
 * 为什么从 kernel 推而不是各写一份：`hosts sync` 只往 settings 里写 kernelPath
 * 这一个绝对路径，两处各推一次就会漂移。两个产物永远在同一个 dist 目录。
 */
export function serveCliPathFromKernel(kernelPath: string): string | undefined {
  if (!/kernel\.js$/.test(kernelPath)) return undefined;
  return kernelPath.replace(/kernel\.js$/, 'main.js');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/hosts.test.ts`
Expected: PASS

- [ ] **Step 5: 在 `claude/hooks/register.ts` 的 `fetchOrSpawn` 之后加第三级**

把 `fetchOrSpawn` 末尾改为：

```ts
  // 路径二：子进程。kernel 的绝对路径同样来自 settings。
  const kernelPath = await kernelPathFromSettings($, next);
  if (kernelPath === undefined) return undefined;
  try {
    const run = await $.process.run({
      argv: ['node', kernelPath, ...target.kernelArgs],
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: next.signal,
    });
    if (run.exitCode !== 0) return undefined;
    return run.stdout;
  } catch {
    return undefined;
  }
```

并在调用方（`searchOrRead`）里，收到 `undefined` 之后加：

```ts
/**
 * 两条路都失败时，尝试拉起服务再走一次 HTTP。
 *
 * 为什么放在这里而不是 `fetchOrSpawn` 内部：这两条路失败意味着这次搜索本来
 * 就要失败了，此刻多付一次 `serve --ensure` 的成本是可以接受的；如果放在
 * 每条路径内部，每次 tool.call 都会多 spawn 一个进程探一次，代价完全不同。
 *
 * 沙箱里没有 `process`，所以用 `$.process.run` 跑裸名 'node'，与已有的
 * 子进程兜底完全同一套做法。
 */
async function wakeServe($: HostDollar, next: HostNext): Promise<boolean> {
  const kernelPath = await kernelPathFromSettings($, next);
  if (kernelPath === undefined) return false;
  const cliPath = kernelPath.replace(/kernel\.js$/, 'main.js');
  if (cliPath === kernelPath) return false;
  try {
    const run = await $.process.run({
      argv: ['node', cliPath, 'serve', '--ensure'],
      timeoutMs: WAKE_TIMEOUT_MS,
      signal: next.signal,
    });
    return run.exitCode === 0;
  } catch {
    return false;
  }
}
```

新增常量，紧邻已有的 `SEARCH_TIMEOUT_MS`：

```ts
/** 唤醒服务的上限。与 omp 侧同名常量保持一致。 */
const WAKE_TIMEOUT_MS = 15_000;
```

在 `searchOrRead` 里接上：

```ts
  const first = await fetchOrSpawn($, next, target);
  if (first !== undefined) return first;
  if (await wakeServe($, next)) {
    // 服务刚起来，再走一次 HTTP；仍然失败就交回原生实现。
    const retry = await callServe($, next, target.endpoint, target.params);
    if (retry !== undefined) return retry;
  }
  return undefined;
```

**注意：** 若 `searchOrRead` 的实际函数名或结构与此不同，以源码为准，不要照抄这里的名字——先 `grep -n "fetchOrSpawn" claude/hooks/register.ts` 看真实调用点。

- [ ] **Step 6: 类型检查与提交**

```bash
npx tsc --noEmit
python -I -c "import io; io.open('.git-commit-msg.tmp','w',encoding='utf-8',newline='\n').write('Claude hook 加第三级兜底：两条路都失败时拉起服务再试一次\n\nhook 沙箱里没有 globalThis.process，所以不能复用 src/serveEnsure.ts，\n只能走 $.process.run 跑与 omp 侧同一条 serve --ensure。\n兜底放在两条路都失败之后，而不是每条路径内部——后者会让每次 tool.call\n都多 spawn 一个进程探一次。\n')"
git add claude/hooks/register.ts src/hosts.ts src/hosts.test.ts .git-commit-msg.tmp
git commit -F .git-commit-msg.tmp
rm -f .git-commit-msg.tmp
```

---

### Task 5: 端到端验收

**Files:**
- 无新增文件。这是验证任务。

- [ ] **Step 1: 停掉服务，删掉 runtime.json**

```bash
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -like '*serve*' } | Stop-Process -Force"
rm -f ~/.searchfuse/runtime.json
```

- [ ] **Step 2: 验 S1——服务已跑时不改写文件**

```bash
node dist/main.js serve --daemon &
sleep 3
node -e "const fs=require('fs'),os=require('os'),path=require('path');
const f=path.join(os.homedir(),'.searchfuse','runtime.json');
const before=fs.statSync(f).mtimeMs;
import('./dist/serveEnsure.js').then(async m=>{
  const r=await m.ensureServeRunning();
  console.log('started=',r.started,'port=',r.port);
  console.log('mtime unchanged:',fs.statSync(f).mtimeMs===before);
});"
```

Expected: `started= false`，`mtime unchanged: true`

- [ ] **Step 3: 验 S2、S3——服务死了也能拉起来**

```bash
rm -f ~/.searchfuse/runtime.json
node -e "import('./dist/serveEnsure.js').then(async m=>{
  const r=await m.ensureServeRunning();
  console.log('started=',r.started,'port=',r.port);
});"
node -e "const fs=require('fs'),os=require('os'),path=require('path');
const rt=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.searchfuse','runtime.json'),'utf8'));
require('http').get({port:rt.port,path:'/healthz',headers:{Connection:'close'}},res=>{
  console.log('healthz=',res.statusCode);res.resume();}).on('error',e=>console.log('ERR',e.code));"
```

Expected: `started= true`、`port= <数字>`、`healthz= 200`

**注意：** `dist/serveEnsure.js` 需要 `vite build` 才会出现（它是 `src/` 的产物）。先跑 `pnpm build`。

- [ ] **Step 4: 验 S5、S6——路由动作与跨站拒绝**

```bash
node -e "(async()=>{
const registered=[];
const scope={webServer:{register:(r)=>{registered.push(r);return()=>{}}},settings:{register:()=>{}},effect:(fn)=>fn()};
const ctx={effect:(fn)=>fn(),inject:(d,k)=>k(scope),tools:{register:()=>()=>{}},web:{registerSearchProvider:()=>()=>{}},on:()=>()=>{}};
const mod=await import('./dsh/index.js');
mod.apply(ctx,{searchProvider:false,readPage:false,engineTools:false});
const route=registered.find(r=>r.path==='/searchfuse/config');
function call(method,body,origin){
  return new Promise(resolve=>{
    const res={writeHead:(s)=>{res.status=s},end:(b)=>{res.body=b;resolve(res)}};
    const req={method,url:'/searchfuse/config',headers:{host:'127.0.0.1',...(origin?{origin}:{})},[Symbol.asyncIterator]:async function*(){if(body)yield Buffer.from(JSON.stringify(body))}};
    route.handler(req,res);
  });
}
const ok=await call('POST',{action:'ensureServe'});
console.log('S5 status',ok.status,'body',ok.body.slice(0,120));
const evil=await call('POST',{action:'ensureServe'},'https://evil.example');
console.log('S6 status',evil.status,'(应为 403)');
})()"
```

Expected: S5 返回 200 且含 `"ok":true` 与 `"port"`；S6 返回 403

- [ ] **Step 5: 全量测试与两个 tsconfig**

```bash
npx tsc --noEmit && npx tsc -p tsconfig.dsh.json --noEmit
npx vitest run
```

Expected: 两个 tsconfig 都是 0 错误；全量测试的失败只允许是已知的 flaky（`main.test.ts` 的 spawn 用例、`mcp/protocol.test.ts`）

- [ ] **Step 6: 更新 CLAUDE.md 并提交**

把实测输出（端口、mtime 结论、S6 的 403）记进 `CLAUDE.md` 的「本地服务生命周期」一节，然后：

```bash
python -I -c "import io; io.open('.git-commit-msg.tmp','w',encoding='utf-8',newline='\n').write('端到端验收：本地服务的三条自愈路径\n\nS1 服务已跑时不改写 runtime.json、S2/S3 服务缺失时能拉起、\nS5 路由动作返回端口、S6 跨站仍被 403 拒绝。\n')"
git add -A ':!CLAUDE.md'
git commit -F .git-commit-msg.tmp
rm -f .git-commit-msg.tmp
```

---

## Self-Review

**Spec 覆盖：**

| spec 要求 | 落在哪个任务 |
| :-- | :-- |
| §3.1 `ensureServeRunning()` 判据 | Task 1（`src/` 侧）、Task 2 Step 3（`dsh/` 侧的等价实现） |
| §3.2 三个调用点（Claude / dsh / omp 不改） | Task 2（dsh）、Task 4（Claude） |
| §3.3 卡片动作 `{action:'ensureServe'}` 与 `serve` 摘要段 | Task 2（后端）、Task 3（前端） |
| §3.4 omp 假阳性（已完成） | 不在本计划范围，已由 `1b5cd79` 落地 |
| §四 S1–S7 | Task 5 覆盖 S1、S2、S3、S5、S6；S4（Claude 实跑）与 S7（插件加载不卡）**没有独立断言**——已知缺口，见下 |

**类型一致性：** `EnsureOutcome` / `EnsureOptions` / `readServeRuntimeFile`（Task 1 定义）与 `ServeRuntimeFile` / `readServeRuntime` / `serveStatus` / `startServe`（Task 2 定义）分属两棵编译树，同名语义、不同名字，这是刻意的：两处不可能互相 import。`serveCliPathFromKernel` 在 Task 4 定义并测试。

**已知缺口（执行时要盯着）：** S4 与 S7 没有独立的失败断言。补法是在 Task 5 追加两条：一条用 `claude -p` 实跑搜索（服务删掉的情况下应仍返回结果），一条用不存在的 `cliPath` 加载插件并计时。
