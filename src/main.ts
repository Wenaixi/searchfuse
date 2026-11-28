#!/usr/bin/env node

declare const __APP_VERSION__: string;

import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  CONFIG_PATH,
  initConfigFile,
  loadConfigFile,
  migrateLegacyDir,
  renderEffectiveConfig,
  setConfigValue,
} from './config.ts';
import { buildCooldownController, clearAllCooldowns, currentStatePath } from './cooldown.ts';
import { effectiveMcp } from './config.ts';
import { formatDoctorReport, runDoctor } from './doctor.ts';
import {
  claudeSettingsPath,
  claudeSkillDir,
  installClaudeSkill,
  installOmpExtension,
  ompConfigPath,
  removeOmpExtension,
  reportClaudeMcp,
  syncClaudeSettings,
  syncOmp,
  syncOmpMcp,
} from './hosts.ts';
import { findEngine, listEngines } from './providers/index.ts';
import { runSearch } from './search.ts';
import { waitForPendingKills } from './subprocess.ts';
import { checkMcpHealth, usableMcpNames } from './mcp/health.ts';
import { ensureServeToken, runtimePath, startServe } from './serve.ts';
import { discoverServe, findRunningServe } from './serveEnsure.ts';
import { identityOf } from './serveIdentity.ts';
import { readSecret } from './util/secretInput.ts';
import { isAlive } from './util/isAlive.ts';
import { registerSearxngCleanup } from './providers/searxngServer.ts';

if (process.env.MODSEARCH_NESTED) {
  process.stderr.write(
    'searchfuse refused to run: it was started from inside an engine that searchfuse itself spawned (recursion guard). An engine such as Grok Build tried to call searchfuse instead of using its own search tools.\n',
  );
  process.exit(1);
}

/** 一次已结束的运行，在真正收尾前最多等多久让被遗弃的工作收场。 */
const EXIT_BACKSTOP_MS = 2_000;

/**
 * 退出兜底计时器挂在 globalThis 上的键。
 *
 * 为什么不用普通模块变量：`main.ts` 一被 import 就会立即解析 argv（commander
 * 的 `program.parse()` 在模块顶层），测试没法在配置好 argv 之前 import 它，
 * 也就拿不到模块作用域里的句柄。挂在 globalThis 的符号上，测试用同一个
 * `Symbol.for(...)` 直接取，不必 import 这个模块。
 *
 * 计时器本身 `.unref()` 过，不阻止进程退出；但它会在测试结束后才触发
 * `process.exit`，那时 spy 已恢复，Vitest 报「unexpected process.exit」。
 */
const EXIT_BACKSTOP_KEY = Symbol.for('searchfuse.exitBackstop');

/** 写入并等到流确实收下，这样退出时不会把它截断。 */
function writeFully(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

const program = new Command();

program
  .name('searchfuse')
  .description(
    'Plug-in web search and page fetch for models without native web access: query or URL in, structured JSON evidence out',
  )
  .version(__APP_VERSION__);

program
  .command('search', { isDefault: true })
  .description('Search the web or X, or fetch a page (default command)')
  .option('-q, --query <text>', 'Search query (or answer focus when combined with -u)')
  .option('-u, --url <url>', 'Fetch this web page instead of searching')
  .option('-o, --output <path>', 'Write result JSON to a file')
  .option(
    '-s, --source <list>',
    'Where to search: web, x, or web,x (default: web, or x when the query is about X)',
  )
  .option(
    '-e, --engine <name>',
    // 从注册表生成而不是手写一份清单：手写的那份在新增 arXiv 引擎时漏了一项，
    // 于是帮助文本少了一个其实可用的选项，而没有任何东西会发现这件事。
    `Engine for this run, overriding config (${listEngines().join(', ')})`,
  )
  .option('-m, --model <name>', 'Engine model, where the engine has one')
  .option('--prompt <text>', 'Extra constraints for this run')
  .option('--max-results <n>', 'Maximum number of search results', '8')
  .option('--timeout <ms>', 'Engine timeout in milliseconds', '180000')
  .option(
    '--deadline <ms>',
    'Wall-clock budget for the whole run in milliseconds, across every engine tried (default: none)',
  )
  .option('--workdir <path>', 'Working directory for engines that run a command')
  .option(
    '--allow-private-network',
    'Allow reserved address ranges for this run, for VPNs that map public hosts into them',
  )
  .action(async (options) => {
    let exitCode = 0;
    try {
      const timeoutMs = Number.parseInt(options.timeout, 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Invalid --timeout. Use a positive integer in milliseconds.');
      }

      let deadlineMs: number | undefined;
      if (options.deadline !== undefined) {
        deadlineMs = Number.parseInt(options.deadline, 10);
        if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
          throw new Error('Invalid --deadline. Use a positive integer in milliseconds.');
        }
      }

      const maxResults = Number.parseInt(options.maxResults, 10);
      if (!Number.isFinite(maxResults) || maxResults <= 0) {
        throw new Error('Invalid --max-results. Use a positive integer.');
      }

      // 只加载一次配置，好让冷却控制器读到与本次运行同一个开关。
      // 关掉时返回 no controller，运行也不碰任何状态。
      const config = loadConfigFile();
      const result = await runSearch({
        query: options.query,
        url: options.url,
        engine: options.engine,
        sources: options.source,
        model: options.model,
        prompt: options.prompt,
        timeoutMs,
        deadlineMs,
        // 从进程启动开始计算截止时间，这样 Node 启动与配置加载
        // 都从调用方手里的那份预算里扣。
        deadlineStartedAt: performance.timeOrigin,
        maxResults,
        workdir: options.workdir,
        allowPrivateNetwork: options.allowPrivateNetwork,
        config,
        cooldown: buildCooldownController(config),
      });

      const output = JSON.stringify(result, null, 2);

      if (options.output) {
        const outputPath = path.resolve(options.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, output, 'utf-8');
      }

      await writeFully(process.stdout, `${output}\n`);
    } catch (error) {
      await writeFully(
        process.stderr,
        [
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          `Known engines: ${listEngines().join(', ')}`,
        ].join('\n') + '\n',
      );
      exitCode = 1;
    }
    // 先等所有待决的 SIGKILL 落地，避免忽略 SIGTERM 的引擎变成孤儿进程，
    // 然后让事件循环自己结束进程。当场直接 exit 会在 fetch socket
    // 关闭途中拆掉它，Windows 上触发 libuv 断言崩溃——而那时结果已经写完了（#38）。
    // 运行在截止时间处遗弃的工作（解析器还没应答的 DNS 查询）仍可能吊住事件循环，
    // 所以用一个 unref 的兜底定时器把它结束掉。
    await waitForPendingKills();
    process.exitCode = exitCode;
    const store = globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>;
    // 覆盖前先清旧句柄。同一进程里这个 action 再次进入（测试里多次 import
    // main.ts 就是这种形态）时，旧计时器既没人引用也没被 clear，它仍会在
    // 2 秒后真的调 process.exit——正是这个改动想消灭的症状。
    const previous = store[EXIT_BACKSTOP_KEY];
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => process.exit(exitCode), EXIT_BACKSTOP_MS);
    timer.unref();
    store[EXIT_BACKSTOP_KEY] = timer;
  });

program
  .command('doctor')
  .description('Diagnose config and routing on this machine (no quota, no network)')
  .option('--json', 'Print the report as JSON')
  .action((options: { json?: boolean }) => {
    try {
      const report = runDoctor();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorReport(report)}\n`);
      }
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

const config = program
  .command('config')
  .description(`Manage ${CONFIG_PATH}. Optional: searchfuse runs without it.`);

config
  .command('init')
  .description(`Create a starter config at ${CONFIG_PATH}`)
  .option('--force', 'Overwrite an existing config file')
  .action((options: { force?: boolean }) => {
    try {
      initConfigFile(CONFIG_PATH, Boolean(options.force));
      process.stdout.write(
        [
          `Created ${CONFIG_PATH}`,
          'Everything is optional. Things you can set:',
          '  searchfuse config set engine <antigravity-cli|tavily|exa|firecrawl|keenable|youcom>   which engine searches',
          '  searchfuse config set <engine>.<apiKey|bin|model|baseURL|keylessFetch> <value>   engine settings',
          '  searchfuse config set cooldown <on|off>   quota cooldown failover (default on)',
          '  searchfuse config set allowPrivateNetwork <true|false>   reach reserved/private ranges (default false)',
          'Search, page fetch, and X need no settings at all: keyless Firecrawl works out of the box.',
          '',
        ].join('\n'),
      );
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

config
  .command('set <key> [value]')
  .description(
    'Set a value, e.g. tavily.apiKey <key>, or search.engine tavily. Omit the value for an .apiKey to be prompted with the echo muted, so the key stays out of argv and shell history (a pipe works too: pbpaste | searchfuse config set tavily.apiKey)',
  )
  .action(async (key: string, value: string | undefined) => {
    try {
      if (value === undefined) {
        // 只有密钥可以交互式询问：其余字段都是普通配置，
        // 省略它的值属于值得点名的错误。
        if (!key.endsWith('.apiKey')) {
          throw new Error(`${key} needs a value: searchfuse config set ${key} <value>`);
        }
        // 在提示之前先校验引擎名：拼写错误必须在这里就失败，
        // 而不是等用户把密钥敲完以后（或者在管道上，等某人的标准输入
        // 已经被吃掉一行之后）才发现。
        const parts = key.split('.').filter(Boolean);
        const engineName = parts[0] === 'engines' ? parts[1] : parts[0];
        if (!engineName || !findEngine(engineName)) {
          throw new Error(
            `Unknown engine: ${engineName ?? key}. Known engines: ${listEngines().join(', ')}.`,
          );
        }
        value = await readSecret(`Enter the value for ${key} (input hidden): `);
      }
      setConfigValue(key, value);
      process.stdout.write(`Saved ${key} to ${CONFIG_PATH}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

config
  .command('show')
  .description('Print the effective config (file + env, source-tagged) with API keys masked')
  .action(() => {
    try {
      process.stdout.write(`${renderEffectiveConfig(loadConfigFile(), process.env)}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

const state = program
  .command('state')
  .description('Manage the quota cooldown state at ~/.searchfuse/state.json');

state
  .command('clear')
  .description('Forget every engine cooldown, so all engines are tried at full priority again')
  .action(() => {
    try {
      const statePath = currentStatePath();
      clearAllCooldowns(statePath);
      process.stdout.write(`Cleared cooldown state (${statePath}).\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

/** 锁久到多久就认为持有者不正常（PID 复用兜底）。正常起服务只要几百毫秒。 */
const STALE_LOCK_MS = 120_000;


/**
 * 读 `~/.searchfuse/runtime.json`，只取端口。
 *
 * **判据必须与 `src/serveEnsure.ts` 的 `readServeRuntimeFile` 逐条一致**：
 * 同一个文件，两处若宽严不一，就会出现「一个判在跑、一个判没在跑」的
 * 错配——宽的那个 exit 0 不动手，严的那个去起新服务，结果是想用的服务
 * 根本没起来。2026-11-25 审查时发现这里原本只判 `typeof === 'number'`，
 * 缺整数校验与 token 校验，与 `serveEnsure.ts` 不一致。
 */
function readRuntimeFile(): { port: number } | undefined {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.searchfuse', 'runtime.json'), 'utf8');
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port)) return undefined;
    if (typeof parsed.token !== 'string' || parsed.token === '') return undefined;
    return { port: parsed.port };
  } catch {
    return undefined;
  }
}

program
  .command('serve')
  .description('Run the local SearXNG-compatible service that omp connects to')
  .option('--ensure', 'Start only if not already running; exit 0 if healthy')
  .option('--daemon', 'Run until killed (no idle exit)')
  .option('--port <n>', 'Port to listen on (default: config serve.port, or 0 for any free port)')
  .action(async (options: { ensure?: boolean; daemon?: boolean; port?: string }) => {
    const config = loadConfigFile();
    // 0 是一个合法取值，表示「由内核挑一个空闲端口」，所以这里不能要求 port > 0。
    const requested = options.port !== undefined ? Number(options.port) : (config.serve?.port ?? 0);
    if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
      process.stderr.write(`Error: invalid port "${options.port ?? config.serve?.port}"\n`);
      process.exit(2);
    }

    // 服务一就绪就调它放锁，见下面 startServe 之后那一段。
    let releaseLockFn: (() => void) | undefined;

    if (options.ensure) {
      // 「已在跑」的判据与插件侧**共用同一个函数**，不只是为了少写一遍：
      // 两处若宽严不一，就会出现「一个判在跑、一个判没在跑」的错配——宽的
      // 那个 exit 0 不动手，严的那个去起新服务，结果是想用的服务根本没起来
      // （或者更糟：多起了一个同指纹实例）。
      //
      // findRunningServe 内部是两级：runtime.json 指向的服务健康就直接认；
      // 否则按目录指纹推导的候选端口逐个探 `/identity`，指纹匹配的才算。
      // 第二级正是「同目录 = 同服务」在服务生命周期侧的落地——文件被 kill
      // 掉的进程来不及删时，这一级能把还活着的服务认回来，不再起第二个。
      const runningPort = await findRunningServe();
      if (runningPort !== undefined) {
        process.stdout.write(`Already running on 127.0.0.1:${runningPort}.\n`);
        process.exit(0);
      }

      // 跨进程互斥。**没有这一步，并发 `--ensure` 会雪崩。**
      //
      // 2026-11-25 现场：118 个僵尸进程、3719 MB 私有内存、118 个监听端口。
      // 机制是上面那段判据在并发下必然全部落空——runtime.json 还没被写出时，
      // 每个 `--ensure` 都读到「没在跑」，于是各自起一个服务；`config.serve.port`
      // 默认是 0（内核挑端口），所以它们各自绑到**不同的空闲端口**，全部成功、
      // 全部常驻。谁最后写 runtime.json 谁赢，其余全成占坑的孤儿。
      //
      // 锁用 `openSync(..., 'wx')` 而不是 `mkdirSync(dir, {recursive: true})`。
      // 2026-11-25 实测：带 recursive 的 mkdirSync 对已存在的目录**静默成功、
      // 不抛 EEXIST**，拿它当锁等于没锁——抢锁的 try 块永远不抛，等待分支是
      // 死代码。`wx` 则是原子排他创建：第一次成功，第二次抛 EEXIST。
      const lockFile = path.join(path.dirname(runtimePath()), 'serve.ensure.lock');
      let holdsLock = false;
      /** 抢锁失败时如果是环境错误，记在这里，让下面直接报出来而不是空等。 */
      let lastLockError: NodeJS.ErrnoException | undefined;
      /**
       * 抢锁。**用 `linkSync`，不是 `openSync('wx')`。**
       *
       * 两者的差别只在回收路径上，但那个差别是致命的：
       * - `openSync('wx')` 依赖「锁文件不存在」才能成功。回收时要先删旧锁
       *   再建新锁，这**两步之间**任何进程都能建锁，于是并发回收时多个进程
       *   各自删一次、各自建一次，全都认为自己持锁。
       * - `linkSync(cand, lock)` 把「建锁」压成一次内核原子操作：只有当
       *   `lock` 不存在时才成功，存在就抛 EEXIST。删完之后最先 link 的那个
       *   赢，其余全部 EEXIST。
       *
       * 2026-11-25 实测（8 进程真并发抢同一把陈旧锁）：
       * `openSync('wx')` 版 8/8 全部报持锁；`linkSync` 版恰好 1 个成功、
       * 7 个 EEXIST。Windows 与 POSIX 都支持 link，Windows 上同样原子。
       */
      const tryTakeLock = (): boolean | 'env-error' | 'retry' => {
        const candidate = `${lockFile}.cand.${process.pid}`;
        try {
          fs.writeFileSync(candidate, `${process.pid}\n`, { mode: 0o600 });
        } catch (writeError) {
          // 连候选文件都写不出来：家目录只读或权限不足。这不是竞争，
          // 是环境问题，不能当成「别人持锁」去空等 20 秒。
          lastLockError = writeError as NodeJS.ErrnoException;
          return 'env-error';
        }
        try {
          fs.linkSync(candidate, lockFile);
          return true;
        } catch (linkError) {
          const code = (linkError as NodeJS.ErrnoException).code;
          // EEXIST 是正常竞争——**除非锁路径上是一个目录**。
          // 上一版锁是 `mkdirSync` 建的**目录**，升级过来的用户家里会残留
          // 一个 `serve.ensure.lock/`。link 到已存在的目录同样报 EEXIST，
          // 但它不是「别人持锁」，是旧版本残留：读不出 owner（EISDIR）、
          // mtime 又是旧的，于是永远判不成陈旧，所有 `--ensure` 空等 20 秒后
          // 失败退出，服务再也起不来。2026-11-25 实测：8 个进程全部
          // 「gave up waiting」，runtime.json 从未写出。
          if (code === 'EEXIST' || code === 'ENOENT' || code === 'EISDIR' || code === 'EPERM') {
            try {
              if (fs.statSync(lockFile).isDirectory()) {
                fs.rmSync(lockFile, { recursive: true, force: true });
                return 'retry';
              }
            } catch {
              // stat 也失败（例如刚被别人删掉）：不是目录，按竞争处理。
            }
          }
          if (code === 'EEXIST') return false;
          lastLockError = linkError as NodeJS.ErrnoException;
          return 'env-error';
        } finally {
          // 候选文件只是一块踏板，锁已经 link 过去，它就没用了。
          // 即使 link 失败也要删，否则每次抢锁都留一个垃圾文件。
          try {
            fs.unlinkSync(candidate);
          } catch {
            // 删不掉不影响结论。
          }
        }
      };

      // **先建父目录。** `linkSync` 不会建父目录：全新安装第一次跑时
      // `~/.searchfuse` 还不存在，抛的是 ENOENT，会被当成「别人持锁」，
      // 于是空等 20 秒后 exit 1，服务永远起不来。`ensureServeToken()`
      // 虽然也建这个目录，但它在锁之后才跑，来不及。2026-11-25 实测。
      try {
        fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
      } catch {
        // 建不出来（例如家目录只读）：让下面的抢锁照常失败，
        // 由失败分支给出结论，这里不提前下判断。
      }

      const take = tryTakeLock();
      if (take === 'env-error') {
        // 家目录写不进去：这不是竞争，空等 20 秒只会得到一句误导的话。
        process.stderr.write(
          `Error: cannot create ${lockFile} (${lastLockError?.code ?? lastLockError?.message}). ` +
            'Check that ~/.searchfuse is writable.\n',
        );
        process.exit(1);
      }
      // 'retry' 表示刚清掉一个老版本残留的目录锁，再抢一次。
      holdsLock = take === true || (take === 'retry' && tryTakeLock() === true);
      if (!holdsLock) {
        // 没抢到。判一下是不是陈旧锁（持有者已死 / 久到不可能是正常启动）。
        //
        // 判据顺序有讲究：先判持有者死活，mtime 只作 PID 复用时的兜底。
        // 两个条件用 `||` 无条件并列的话，一台负载高、起服务超过 STALE_LOCK_MS
        // 的机器上，一个**活着但慢**的持有者会被 mtime 门槛误抢，制造第二个服务。
        let ownerPid = 0;
        try {
          ownerPid = Number(fs.readFileSync(lockFile, 'utf-8').trim());
        } catch {
          // 读不到就是空锁或半写的锁。
        }
        const ownerDead = ownerPid > 0 && !isAlive(ownerPid);
        let tooOld = false;
        try {
          tooOld = Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS;
        } catch {
          // stat 失败：文件可能在判定途中被持有者删掉了。
        }
        if (ownerDead || tooOld) {
          // 回收：删掉旧锁，让所有同样判成陈旧的进程重新去 link。
          // 这里**故意不自己建**——删完之后由下一次 tryTakeLock 决定谁赢，
          // 竞争交给 link 的原子性，不会出现「删旧建新两步之间被插队」的窗口。
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // 别人已经删了：接着抢就是。
          }
          const retake = tryTakeLock();
          if (retake === 'env-error') {
            process.stderr.write(
              `Error: cannot create ${lockFile} (${lastLockError?.code ?? lastLockError?.message}). ` +
                'Check that ~/.searchfuse is writable.\n',
            );
            process.exit(1);
          }
          holdsLock = retake === true || (retake === 'retry' && tryTakeLock() === true);
        }
      }

      if (!holdsLock) {
        // 别人正在起。等它写文件，最多等 20 秒。
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const ready = readRuntimeFile();
          if (ready !== undefined) {
            try {
              const res = await fetch(`http://127.0.0.1:${ready.port}/healthz`, {
                signal: AbortSignal.timeout(2000),
              });
              if (res.ok) {
                process.stdout.write(`Already running on 127.0.0.1:${ready.port}.\n`);
                process.exit(0);
              }
            } catch {
              // 还没就绪，继续等。
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        // **不能传个「成功」的退出码就走。** `serveEnsure.ts` 把「早退 0 且
        // 没有 runtime.json」判成「文件没写出来」这个真故障；并发等待失败若
        // 也退 0，一次正常的并发启动会被误报成文件级故障。等不到就用非 0
        // 退出，让调用方的失败分支说实话。
        //
        // 文案必须区分两种真相：持锁者还在跑（正常的并发启动，稍后重试即可）
        // 与持锁者已经死了（它启动失败了，等下去不会好）。早先这里无条件报
        // 「another serve --ensure is starting up」，而持锁者因候选端口全被
        // 占而 exit 1 时，那句话把用户指向锁去查，可锁根本没问题。
        //
        // 重新读一次锁里的 pid：`ownerPid` 属于上面那个回收分支的块，
        // 而这里是等待超时之后的独立块。
        let waitingOnPid = 0;
        try {
          waitingOnPid = Number(fs.readFileSync(lockFile, 'utf-8').trim());
        } catch {
          // 锁已消失：持锁者正常退出但没写出文件。
        }
        if (waitingOnPid > 0 && !isAlive(waitingOnPid)) {
          process.stderr.write(
            `Error: the process that was starting the service (pid ${waitingOnPid}) exited without writing runtime.json. ` +
              'Check that its candidate ports are free (or set serve.port to a free number).\n',
          );
        } else {
          process.stderr.write('Error: another serve --ensure is starting up; gave up waiting.\n');
        }
        process.exit(1);
      }
      // 持锁期间进程被外部杀掉时，锁会留在原地；上面的陈旧检测会在
      // STALE_LOCK_MS 之后或持有进程消失后回收它。
      const releaseLock = (): void => {
        // **只删自己的锁。** 如果这期间锁被别人回收并重建（陈旧竞态），
        // 直接 unlink 会删掉别人的锁，让第三个进程误以为无人持锁。
        try {
          const owner = Number(fs.readFileSync(lockFile, 'utf-8').trim());
          if (owner === process.pid) fs.unlinkSync(lockFile);
        } catch {
          // 读不出内容：可能是老版本残留的**目录**锁（readFileSync 会抛 EISDIR）。
          // 那种残留在 tryTakeLock 里清，这里不必再动，免得误删别人的东西。
        }
      };
      process.once('exit', releaseLock);
      for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signalName, () => {
          releaseLock();
          process.exit(0);
        });
      }
      releaseLockFn = releaseLock;
    }

    const token = ensureServeToken();
    // 候选端口：显式 `--port` 或配置写了非零端口时尊重它；否则按目录指纹
    // 推导一组。后者的意义是「同一份 .searchfuse 永远算出同一组候选」，
    // 于是客户端不必依赖 runtime.json（它会在服务被 kill 时消失）也能找到服务。
    const identity = identityOf(os.homedir());
    const useCandidates = requested === 0;
    try {
      const handle = await startServe({
        port: requested,
        token,
        idleExitSeconds: options.daemon ? 0 : (config.serve?.idleExitSeconds ?? 0),
        fingerprint: identity.fingerprint,
        ...(useCandidates ? { candidatePorts: identity.ports } : {}),
      });
      process.stdout.write(`Listening on http://127.0.0.1:${handle.port}\n`);

      // **收敛：如果自己不是第一个候选，就让先来的赢。**
      //
      // 候选存在的理由是「谁先来谁占前面的」。但两种情况会让两个实例
      // 同时活着：机器重启后两个都被拉起，或两次并发 ensure 抢锁失败后
      // 各自起。此时客户端按候选顺序探，永远连前面的那个，而后面的实例
      // 只占端口与内存、永远不被使用——它还握着 runtime.json，于是 dsh
      // （文件优先）连它、serveEnsure（候选优先）连前面那个，同一台机器
      // 两个聚合器轮流接管搜索，冷却与缓存各算各的。
      //
      // 判据只看**前序**候选：后面的实例不影响自己，没必要探（省掉 8 次
      // HTTP）。指纹匹配是必须的——恰好占着前序端口的别的程序不算。
      if (useCandidates) {
        const earlier = identity.ports.slice(0, identity.ports.indexOf(handle.port));
        if (earlier.length > 0) {
          const winner = await discoverServe(identity.fingerprint, earlier);
          if (winner !== undefined) {
            process.stdout.write(
              `Port ${handle.port} yielded to the instance already running on 127.0.0.1:${winner.port}.\n`,
            );
            await handle.close();
            releaseLockFn?.();
            process.exit(0);
          }
        }
      }

      // **服务一就绪就放锁。** 持锁到进程退出是错的：`serve` 本来就是常驻
      // 进程，锁会永远不释放，后来者只能等到 20 秒超时——那等于把「互斥」
      // 变成了「排队失败」。互斥要保护的只是「谁来起服务」这一小段。
      releaseLockFn?.();
    } catch (error) {
      releaseLockFn?.();
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

const hosts = program
  .command('hosts')
  .description('Wire searchfuse into dsh / Claude Code / omp, or unwire it');

hosts
  .command('sync')
  .description('Write each host configuration from ~/.searchfuse/config.json')
  .option('--dry-run', 'Show what would change without writing')
  .option('--skip-mcp-probe', 'Register MCP servers without checking they are reachable')
  .action(async (options: { dryRun?: boolean; skipMcpProbe?: boolean }) => {
    try {
      const config = loadConfigFile();
      const lines: string[] = [];

      // omp：**不再写 searxng.endpoint**——搜索改由扩展同名覆盖内置工具完成。
      // 这里只清理历史遗留的 HTTP 接入（endpoint/token/Basic），因为
      // `searxng.endpoint` 是静态配置，跟随机端口天然冲突。
      //
      // 开关必须真的生效：早先无论 enabled 取值都调 syncOmp(undefined)，
      // 于是 `hosts disable omp` 只改配置、扩展照装，用户以为关掉了却
      // 仍在接管搜索。关闭时卸载扩展文件，才是「关掉」。
      const ompEnabled = config.hosts?.omp?.enabled !== false;
      if (options.dryRun) {
        lines.push(`omp: ${ompEnabled ? 'enable' : 'disable'} (${ompConfigPath()})`);
      } else {
        const result = syncOmp(undefined);
        lines.push(
          `omp: ${ompEnabled ? 'enabled' : 'disabled'} (HTTP wiring cleared)` +
            (result.changed ? '' : ', no change') +
            (result.backup ? ` [backup: ${path.basename(result.backup)}]` : ''),
        );
      }

      // omp 扩展：同名覆盖内置 web_search。它 spawn kernel.js，
      // 所以不需要 HTTP 服务，也就绕开了「静态 endpoint vs 随机端口」的冲突。
      if (options.dryRun) {
        lines.push(
          ompEnabled
            ? 'omp extension: would install (shadow builtin web_search)'
            : 'omp extension: would remove (host disabled)',
        );
      } else if (!ompEnabled) {
        // 关掉就要撤掉扩展文件：留着它，omp 每次启动仍会接管搜索，
        // 与 `hosts.omp.enabled=false` 的承诺相反。
        const removed = removeOmpExtension();
        lines.push(
          removed ? 'omp extension: removed (host disabled)' : 'omp extension: none to remove',
        );
      } else {
        // 用运行时字符串拼接，不让 vite 把模板内联成 data URL——
        // 它看到 `new URL(..., import.meta.url)` 会当作静态资源打包，
        // 结果 fileURLToPath 收到一个 "data:text/javascript;base64,..." 并报错。
        const selfDir = path.dirname(fileURLToPath(import.meta.url));
        const templatePath = path.join(selfDir, '..', 'omp', 'extension.ts');
        try {
          const template = fs.readFileSync(templatePath, 'utf-8');
          const kernelPath = path.join(selfDir, 'kernel.js');
          const installed = installOmpExtension(template, kernelPath);
          lines.push(`omp extension: installed (${path.basename(installed)})`);
        } catch (error) {
          lines.push(`omp extension: skipped (${error instanceof Error ? error.message : String(error)})`);
        }
      }

      // Claude Code：镜像开关到它的 settings（插件自己写不进去）。
      const claudeEnabled = config.hosts?.claudeCode?.enabled !== false;
      if (options.dryRun) {
        lines.push(`claudeCode: ${claudeEnabled ? 'enable' : 'disable'} (${claudeSettingsPath()})`);
      } else {
        // 两条绝对路径：mod 的沙箱里 `~` 不展开、HOME 读不到，
        // 所以由这里（插件之外的 CLI）写进 settings。
        const selfDir = path.dirname(fileURLToPath(import.meta.url));
        const result = syncClaudeSettings(claudeEnabled, {
          runtimePath: path.join(os.homedir(), '.searchfuse', 'runtime.json'),
          kernelPath: path.join(selfDir, 'kernel.js'),
          // 预先算好身份写进 settings：mod 沙箱里没有 process 与 crypto，
          // 自己算不出指纹，只能拿现成的。
          identity: identityOf(os.homedir()),
        });
        lines.push(
          `claudeCode: ${claudeEnabled ? 'enabled' : 'disabled'}` +
            (result.changed ? '' : ' (no change)') +
            (result.backup ? ` [backup: ${path.basename(result.backup)}]` : ''),
        );
      }

      // Claude Code mod：把 `claude/` 同步进 `~/.claude/skills/searchfuse-mod/`，
      // 让它作为 `@skills-dir` 插件常驻加载，从而在**每次会话**都接管内置
      // WebSearch，而不是只在带 `--plugin-dir` 的那一次。
      //
      // 关闭时**不删目录**：`register.ts` 每次 tool.call 都读 enabled 开关，
      // 关掉即交回原生实现。删了反而让重新开启时没有任何东西可加载。
      {
        const selfDir = path.dirname(fileURLToPath(import.meta.url));
        const sourceDir = path.join(selfDir, '..', 'claude');
        if (options.dryRun) {
          lines.push(`claudeCode mod: would sync (${claudeSkillDir()})`);
        } else {
          const synced = installClaudeSkill(sourceDir);
          lines.push(
            synced.changed
              ? `claudeCode mod: synced ${synced.installed.join(', ')}`
              : 'claudeCode mod: already up to date',
          );
        }
      }

      // MCP：先用默认集合补缺，再探测可达性——注册一个连不上的 server
      // 比不注册更糟，模型每次用它都要等超时。
      const mcpSet = effectiveMcp(config);
      const registeredNames = Object.keys(mcpSet);

      if (options.dryRun) {
        lines.push(`mcp: would register ${registeredNames.join(', ') || '(none)'} (after reachability probe)`);
      } else {
        let usable = registeredNames;
        if (!options.skipMcpProbe) {
          const servers = Object.fromEntries(
            registeredNames
              .map((name) => [name, mcpSet[name]] as const)
              .filter(([, entry]) => entry !== undefined)
              .map(([name, entry]) => [
                name,
                {
                  transport: 'streamable-http' as const,
                  url: typeof entry.url === 'string' ? entry.url : '',
                  ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
                },
              ])
              .filter(([, entry]) => (entry as { url: string }).url !== ''),
          );
          const health = await checkMcpHealth(servers);
          usable = usableMcpNames(health);
          const dead = registeredNames.filter((name) => !usable.includes(name));
          if (dead.length > 0) {
            for (const name of dead) {
              const reason = health[name]?.reason ?? '不可达';
              lines.push(`mcp: skipping ${name} (${reason})`);
            }
          }
        }

        const usableConfig = Object.fromEntries(usable.map((name) => [name, mcpSet[name]!]));
        const mcp = syncOmpMcp({ mcp: usableConfig });
        lines.push(
          mcp.added.length > 0
            ? `mcp: added to omp: ${mcp.added.join(', ')}` +
                (mcp.backup ? ` [backup: ${path.basename(mcp.backup)}]` : '')
            : 'mcp: omp already has all reachable servers (no change)',
        );
        const claudeMcp = reportClaudeMcp();
        if (claudeMcp.length > 0) {
          lines.push(`mcp: already installed in Claude Code: ${claudeMcp.join(', ')}`);
        }
      }

      process.stdout.write(`${lines.join('\n')}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

const HOST_NAMES = ['dsh', 'claudeCode', 'omp'] as const;

hosts
  .command('enable <host>')
  .description(`Mark a host as enabled: ${HOST_NAMES.join(' | ')}`)
  .action((name: string) => {
    try {
      if (!HOST_NAMES.includes(name as (typeof HOST_NAMES)[number])) {
        throw new Error(`Unknown host "${name}". Known: ${HOST_NAMES.join(', ')}`);
      }
      setConfigValue('hosts.' + hostConfigKey(name), 'true');
      process.stdout.write(`Enabled ${name}. Run \`searchfuse hosts sync\` to apply.\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

hosts
  .command('disable <host>')
  .description(`Mark a host as disabled: ${HOST_NAMES.join(' | ')}`)
  .action((name: string) => {
    try {
      if (!HOST_NAMES.includes(name as (typeof HOST_NAMES)[number])) {
        throw new Error(`Unknown host "${name}". Known: ${HOST_NAMES.join(', ')}`);
      }
      setConfigValue('hosts.' + hostConfigKey(name), 'false');
      process.stdout.write(`Disabled ${name}. Run \`searchfuse hosts sync\` to apply.\n`);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

/** 配置里的键名与命令行名字可能不同（`claude-code` → `claudeCode`）。 */
function hostConfigKey(name: string): string {
  return name === 'claude-code' ? 'claudeCode' : name;
}


// 改名后第一次运行时，把旧目录里的配置、冷却状态与缓存搬过来。幂等，
// 旧目录还在，出问题能回退。放在解析命令之前，于是每条命令都享受它，
// 而 `doctor` 也会看到搬过来的配置。
migrateLegacyDir();

// 内置 SearXNG 是子进程，进程走的时候必须带走：否则 onefile launcher 会
// 留下持久的 server 子进程占着端口。
registerSearxngCleanup();

// parseAsync：`config set` 里的隐藏提示路径需要等待用户输入。
await program.parseAsync(process.argv, { from: 'node' });
