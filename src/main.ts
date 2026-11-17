#!/usr/bin/env node

declare const __APP_VERSION__: string;

import { Command } from 'commander';
import * as fs from 'fs';
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
import { formatDoctorReport, runDoctor } from './doctor.ts';
import { findEngine, listEngines } from './providers/index.ts';
import { runSearch } from './search.ts';
import { waitForPendingKills } from './subprocess.ts';
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

// 改名后第一次运行时，把旧目录里的配置、冷却状态与缓存搬过来。幂等，
// 旧目录还在，出问题能回退。放在解析命令之前，于是每条命令都享受它，
// 而 `doctor` 也会看到搬过来的配置。
migrateLegacyDir();

// parseAsync：`config set` 里的隐藏提示路径需要等待用户输入。
await program.parseAsync(process.argv, { from: 'node' });
