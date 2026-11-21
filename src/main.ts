#!/usr/bin/env node

declare const __APP_VERSION__: string;

import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  ompConfigPath,
  reportClaudeMcp,
  syncClaudeSettings,
  syncOmp,
  syncOmpMcp,
} from './hosts.ts';
import { findEngine, listEngines } from './providers/index.ts';
import { runSearch } from './search.ts';
import { waitForPendingKills } from './subprocess.ts';
import { checkMcpHealth, usableMcpNames } from './mcp/health.ts';
import { ensureServeToken, startServe } from './serve.ts';
import { readSecret } from './util/secretInput.ts';

if (process.env.MODSEARCH_NESTED) {
  process.stderr.write(
    'searchfuse refused to run: it was started from inside an engine that searchfuse itself spawned (recursion guard). An engine such as Grok Build tried to call searchfuse instead of using its own search tools.\n',
  );
  process.exit(1);
}

/** 一次已结束的运行，在真正收尾前最多等多久让被遗弃的工作收场。 */
const EXIT_BACKSTOP_MS = 2_000;

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
    setTimeout(() => process.exit(exitCode), EXIT_BACKSTOP_MS).unref();
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

program
  .command('serve')
  .description('Run the local SearXNG-compatible service that omp connects to')
  .option('--ensure', 'Start only if not already running; exit 0 if healthy')
  .option('--daemon', 'Run until killed (no idle exit)')
  .option('--port <n>', 'Port to listen on (default: config serve.port or 7799)')
  .action(async (options: { ensure?: boolean; daemon?: boolean; port?: string }) => {
    const config = loadConfigFile();
    const port = options.port !== undefined ? Number(options.port) : (config.serve?.port ?? 7799);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      process.stderr.write(`Error: invalid port "${options.port ?? config.serve?.port}"\n`);
      process.exit(2);
    }

    if (options.ensure) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) {
          process.stdout.write(`Already running on 127.0.0.1:${port}.\n`);
          process.exit(0);
        }
      } catch {
        // 不通：往下启动。
      }
    }

    const token = ensureServeToken();
    try {
      const handle = await startServe({
        port,
        token,
        idleExitSeconds: options.daemon ? 0 : (config.serve?.idleExitSeconds ?? 0),
      });
      process.stdout.write(`Listening on http://127.0.0.1:${handle.port}\n`);
    } catch (error) {
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

      // omp：走本地服务时写 endpoint + token + modelRoles.web。
      const ompEnabled = config.hosts?.omp?.enabled !== false;
      if (options.dryRun) {
        lines.push(`omp: ${ompEnabled ? 'enable' : 'disable'} (${ompConfigPath()})`);
      } else {
        const port = config.serve?.port ?? 7799;
        const result = ompEnabled
          ? syncOmp({ endpoint: `http://127.0.0.1:${port}`, token: readServeToken(), webRole: 'web/searxng' })
          : syncOmp(undefined);
        lines.push(
          `omp: ${ompEnabled ? 'enabled' : 'disabled'}` +
            (result.changed ? '' : ' (no change)') +
            (result.backup ? ` [backup: ${path.basename(result.backup)}]` : ''),
        );
      }

      // Claude Code：镜像开关到它的 settings（插件自己写不进去）。
      const claudeEnabled = config.hosts?.claudeCode?.enabled !== false;
      if (options.dryRun) {
        lines.push(`claudeCode: ${claudeEnabled ? 'enable' : 'disable'} (${claudeSettingsPath()})`);
      } else {
        const result = syncClaudeSettings(claudeEnabled);
        lines.push(
          `claudeCode: ${claudeEnabled ? 'enabled' : 'disabled'}` +
            (result.changed ? '' : ' (no change)') +
            (result.backup ? ` [backup: ${path.basename(result.backup)}]` : ''),
        );
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

/** 读服务 token；没有就报错，因为写进 omp 配置的必须是真值。 */
function readServeToken(): string {
  const tokenPath = path.join(os.homedir(), '.searchfuse', 'serve-token');
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (token === '') throw new Error(`${tokenPath} is empty`);
    return token;
  } catch (error) {
    throw new Error(
      `Cannot read the serve token at ${tokenPath}. Run \`searchfuse serve --ensure\` first ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

// 改名后第一次运行时，把旧目录里的配置、冷却状态与缓存搬过来。幂等，
// 旧目录还在，出问题能回退。放在解析命令之前，于是每条命令都享受它，
// 而 `doctor` 也会看到搬过来的配置。
migrateLegacyDir();

// parseAsync：`config set` 里的隐藏提示路径需要等待用户输入。
await program.parseAsync(process.argv, { from: 'node' });
