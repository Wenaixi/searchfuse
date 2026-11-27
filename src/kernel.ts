// 内核入口：把一次搜索变成一个可被宿主进程调用的子进程。
//
// 为什么需要它：dsh 与 Claude Code 都通过 spawn 一个 Node 子进程来做搜索，
// 而不是各自实现一遍聚合。这个文件就是那个子进程的入口——它只有一层薄
// 包装（解析 argv → 调 `runSearch` → 把结果写成 JSON），聚合逻辑仍在
// `src/search.ts` 里，只有一份。
//
// I/O 契约（三宿主与 CLI 共用）：
//
//   node dist/kernel.js --query <text> [--source web|x] [--max-results N]
//                       [--timeout MS] [--deadline MS] [--engine NAME]
//   node dist/kernel.js --url <url> [-q <focus>]      # 抓单页，不搜索
//
//   stdout  单行 JSON = RunSearchResult
//   退出码   0 = 有结果；1 = 无结果/全部引擎失败；2 = 参数错误
//   stderr  诊断文本（不参与解析）
//
// `-q` 与 `--query` 都接受，因为 dsh 已经在传 `-q`，而新调用方习惯用长选项。
// 两者等价，不为迁就任何一方去改已验证的代码。
//
// 为什么 `--url` 必须能单独用：Claude 与 omp 两处的 `read_page` 都只传
// `--url`，早先 kernel 强求非空 `--query`，于是两边的 read_page 一律
// exit 2——工具注册得成功，调用必败，且失败信息还指向「参数错误」而不是
// 「不支持」。`--url` 单独用与 CLI 的 `-u` 语义相同。

import {
  allowsPrivateNetwork,
  currentConfigPath,
  loadConfigFile,
} from './config.ts';
import { buildCooldownController } from './cooldown.ts';
import { runSearch } from './search.ts';

/** 退出码。列成常量而不是散在代码里，因为调用方要按它们分支。 */
const EXIT_OK = 0;
const EXIT_NO_RESULT = 1;
const EXIT_BAD_ARGS = 2;

/** 默认单个引擎与整轮的预算，与 CLI 的缺省一致。 */
const DEFAULT_TIMEOUT_MS = 180_000;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_BAD_ARGS);
}

/**
 * 取一个选项的值。同一个值有多个别名时按传入顺序优先。
 *
 * 手写而不是用 commander：这个入口要极薄，多加一个依赖就多一层要与
 * 宿主版本对齐的东西。参数只有六个，手写更可靠。
 *
 * 别名必须把 CLI（`dist/main.js`）的短选项也列上：两边共用同一套 argv
 * 契约，只认长选项会让 `-e foo`、`-s x` 被**整个跳过**，而不是报错。
 * 那种跳过是最坏的一种沉默——参数看着给了，行为却是「按默认来」，
 * 于是 `-e <拼错的引擎名>` 会回退成一次全引擎融合，花掉谁的额度都不会有人知道。
 */
function takeOption(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]!)) {
      const value = args[i + 1];
      // 下一个词如果本身是一个选项，说明这个选项没带值。长选项以 `--`
      // 开头，短选项是单破折号加一个字母（`-q`、`-e` 等），两种都要拦住，
      // 否则 `--engine -q x` 会把 `-q` 当成引擎名。
      if (value === undefined || looksLikeOption(value)) {
        return undefined;
      }
      return value;
    }
  }
  return undefined;
}

/** 一个词是不是选项本身（而不是它的值）。 */
function looksLikeOption(word: string): boolean {
  if (word.startsWith('--')) {
    return true;
  }
  // 单个破折号加一个字母：`-q`、`-e`、`-s`、`-m`、`-u`、`-o`。
  // 只认这种形状，才不会把 `-1` 这类负数或 `-` 本身当成选项。
  return /^-[A-Za-z]$/.test(word);
}

/** 解析成整数；给了但不成整数就报错，而不是静默回落默认值。 */
function takeNumber(args: string[], ...names: string[]): number | undefined {
  const raw = takeOption(args, ...names);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${names[0]} takes a positive number, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 两种模式：搜索（要 --query）与抓页（要 --url，可附 -q 作关注点）。
  // 判定放在这里而不是靠 runSearch 内部，是因为「参数缺失」要退 2，
  // 而 runSearch 的失败会退 1——调用方按退出码区分「重试」与「别重试」。
  const query = takeOption(args, '-q', '--query');
  // `-u` 必须和 `--url` 一起认：dsh 侧的 read_page 传的就是 `-u`。
  // 只认长选项会让它退 2「nothing to do」——工具注册成功、调用必败。
  const url = takeOption(args, '-u', '--url');

  const hasQuery = query !== undefined && query.trim() !== '';
  const hasUrl = url !== undefined && url.trim() !== '';

  if (!hasQuery && !hasUrl) {
    fail('nothing to do: give --query (or -q) to search, or --url to fetch a page');
  }

  const config = loadConfigFile(currentConfigPath());
  const result = await runSearch({
    query,
    url,
    // 短选项与 CLI 对齐：Claude Code 与 omp 侧的调用方按 CLI 手册传 `-e`
    // 与 `-s`，只认长选项会让它们被静默忽略（见 takeOption 的注释）。
    engine: takeOption(args, '-e', '--engine'),
    sources: takeOption(args, '-s', '--source'),
    timeoutMs: takeNumber(args, '--timeout') ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: takeNumber(args, '--deadline'),
    // 从进程启动开始算，这样 Node 启动与配置加载都从调用方的预算里扣。
    deadlineStartedAt: performance.timeOrigin,
    maxResults: takeNumber(args, '--max-results'),
    allowPrivateNetwork: allowsPrivateNetwork(config),
    config,
    // 冷却控制器：没有它，被额度耗尽的引擎每跑一次都会被重新撞一遍。
    // **kernel 是三端真正跑搜索的入口**（dsh、claude hook、omp 扩展全走它），
    // 早先只有 CLI 的 `searchfuse search` 传了它，于是冷却在生产路径上
    // 从来没生效过——state.json 永远是空的。
    cooldown: buildCooldownController(config),
  });

  // 单行 JSON：调用方按行解析，不需要处理多行或尾随内容。
  process.stdout.write(`${JSON.stringify(result)}\n`);

  // 「有结果」的定义：至少有一个来源真的作答了。`unavailable` 表示没有
  // 任何东西能服务那个来源；引擎失败但另一个成功仍是成功，那正是聚合
  // 的意义。
  const hasResults = result.results.some((entry) => entry.status !== 'unavailable');
  process.exit(hasResults ? EXIT_OK : EXIT_NO_RESULT);
}

main().catch((error: unknown) => {
  // 未捕获的失败也要守住契约：stderr 给原因，退出码用「无结果」，
  // 这样调用方不会把它误判成参数错误而放弃重试其他引擎。
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_NO_RESULT);
});
