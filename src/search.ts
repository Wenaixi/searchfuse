import {
  aggregateCacheTtlMs,
  aggregateDeadlineMs,
  aggregateMode,
  engineSettings,
  exposeOf,
  loadConfigFile,
  type ModsearchConfig,
} from './config.ts';
import { coolingEngineEntry, coolingEntry, type CooldownController } from './cooldown.ts';
import { fanout, type FanoutTarget } from './aggregate/fanout.ts';
import { rrfFuse } from './aggregate/rrf.ts';
import { cacheKey, currentCachePath, pruneCache, readCache, writeCache } from './aggregate/cache.ts';
import {
  allEngines,
  enginesForRole,
  type EngineOutput,
  type EngineRequest,
  type RunMode,
  type SearchEngine,
  type Source,
} from './providers/index.ts';
import { parseSources, planRun, SOURCE_ROLE, type SourcePlan } from './router.ts';
import { runCommand } from './subprocess.ts';
import { isApiKeyFailure, splitApiKeys } from './util/apiKeys.ts';
import { redactSecrets } from './util/redact.ts';

export interface RunSearchOptions {
  query?: string;
  url?: string;
  /** 本次运行指定使用的引擎，例如 `tavily`。 */
  engine?: string;
  /** 来源列表，例如 `web,x`。不传时由查询内容决定。 */
  sources?: string;
  model?: string;
  prompt?: string;
  /** 单个引擎的预算：每次尝试最多可以跑这么久。 */
  timeoutMs?: number;
  /**
   * 整次运行的墙钟预算，从运行开始算起。每次尝试拿到的是 `timeoutMs`
   * 与剩余时间中较小的那个；轮到它时预算已经用完的引擎直接跳过。
   * 缺省表示没有全轮上限，所以 N 个引擎的链最多可能花掉 N 倍的 `timeoutMs`。
   */
  deadlineMs?: number;
  /**
   * 截止时间从哪个纪元毫秒开始计算。默认从本次运行的起点算。
   * CLI 传的是进程启动时刻，这样 Node 启动与配置加载都从调用方手里
   * 那份预算里扣。
   */
  deadlineStartedAt?: number;
  maxResults?: number;
  workdir?: string;
  /** 针对本次运行、一次性覆盖本地引擎私网防护的开关。 */
  allowPrivateNetwork?: boolean;
  /** 注入的配置，测试用。否则从 ~/.modsearch/config.json 加载。 */
  config?: ModsearchConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * 本次运行的配额冷却：让链避开已经耗尽的引擎，并在运行推进的过程中
   * 记录或清除它们的状态。缺省表示冷却关闭（要么开关是关的，要么调用方
   * 根本不使用它），路由行为与冷却机制出现之前完全一致。
   */
  cooldown?: CooldownController;
}

/** 这一条目对请求的来源服务得如何。 */
export type SourceStatus = 'ok' | 'degraded' | 'unavailable';

/** 对某个引擎的一次尝试，按实际尝试的先后顺序排列。 */
export interface EngineAttempt {
  engine: string;
  /** 配置里的密钥下标，从 0 开始。只有引擎配了多个密钥时才会出现。 */
  keyIndex?: number;
  /** 引擎返回了结果时为 true，失败或被跳过时为 false。 */
  ok: boolean;
  /** 只有 `ok` 为 false 时才出现：失败消息。 */
  error?: string;
  /** 这次尝试花了多久；什么都没跑时是 null。 */
  durationSeconds: number | null;
  /** 这次尝试报告的美元花费，只有引擎跟踪花费时才有（exa）。其余情况不出现。 */
  cost?: number;
  /** 这次尝试消耗的额度，只有引擎跟踪额度时才有（firecrawl）。其余情况不出现。 */
  credits?: number;
}

/** 引擎在 usage 里报告的花费：exa 的美元，firecrawl 的额度。 */
function engineSpend(usage: unknown): { cost?: number; credits?: number } {
  if (!usage || typeof usage !== 'object') {
    return {};
  }
  const record = usage as Record<string, unknown>;
  const spend: { cost?: number; credits?: number } = {};
  if (typeof record.costDollars === 'number') {
    spend.cost = record.costDollars;
  }
  if (typeof record.creditsUsed === 'number') {
    spend.credits = record.creditsUsed;
  }
  return spend;
}

/** 一个来源的答案。引擎的结果字段会被摊平，与这些字段并排放。 */
export interface SourceResult {
  /** 这条答案实际来自的语料库。可能与 requestedSource 不同。 */
  source: Source;
  /** 请求的语料库。除非本次运行降级，否则等于 `source`。 */
  requestedSource: Source;
  /** 是哪个引擎作答的；来源不可达时为 null。 */
  engine: string | null;
  model?: string;
  /**
   * `ok`：按请求的语料库作答。`degraded`：由一个替代语料库作答
   * （例如用网页应答一个 X 请求，所以是二手证据）。`unavailable`：
   * 没有任何东西能服务这个来源，`items` 为空。
   */
  status: SourceStatus;
  /**
   * 这个来源的路由与运行期警告：某引擎失败并被替换、降级到替代语料库、
   * 配置里的一处笔误、本地引擎的「不做合成」与「已允许私网」通告。
   * 这些说的是答案**怎么来的**，不是答案里的事实。
   */
  warnings: string[];
  /** 这个来源试过的每个引擎，按顺序，附带每次尝试的结果。 */
  attempts: EngineAttempt[];
  durationSeconds: number | null;
  [resultField: string]: unknown;
}

export interface RunSearchResult {
  mode: RunMode;
  query: string | null;
  url: string | null;
  /** 永远是数组，每个来源一条，保证结构始终不变。 */
  results: SourceResult[];
  meta: {
    generatedAt: string;
    durationSeconds: number;
  };
}

/** 缓存融合结果的上限，让文件大小有界，无需后台任务来清理。 */
const CACHE_ENTRY_CAP = 100;

const DEFAULT_TIMEOUT_MS = 180_000;
// 先给引擎自己的超时一个开火的机会；SIGTERM 只是兜底。
const KILL_GRACE_MS = 30_000;
// 在有运行截止时间的情况下宽限期很短，所以一个无视自身超时的引擎
// 不能把回退引擎本该拿到的时间也耗掉。
const DEADLINE_KILL_GRACE_MS = 5_000;

/**
 * 某个来源的引擎全都没能作答。它携带每个引擎的尝试记录，好让多来源运行时
 * 能把这些记录呈现在该来源的 `attempts` 里，而不是把它们丢给抛错。
 * 它的消息与旧版朴素 Error 完全一致，所以单来源那条路径（也就是能走到 CLI
 * 的那条）打印出来的内容与以前一模一样。
 */
class SourceRunError extends Error {
  constructor(
    message: string,
    readonly attempts: EngineAttempt[],
  ) {
    super(message);
    this.name = 'SourceRunError';
  }
}

/** 把一个耗尽了全部引擎的来源，转成显式的 unavailable 条目。 */
function failedSourceEntry(plan: SourcePlan, error: unknown): SourceResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    source: plan.source,
    requestedSource: plan.source,
    engine: null,
    status: 'unavailable',
    summary: '',
    items: [],
    uncertainty: [],
    warnings: [message],
    attempts: error instanceof SourceRunError ? error.attempts : [],
    durationSeconds: null,
  };
}

export function resolveMode(query?: string, url?: string): RunMode {
  const hasQuery = Boolean(query?.trim());
  const hasUrl = Boolean(url?.trim());

  if (!hasQuery && !hasUrl) {
    throw new Error('Provide a search query (-q) or a URL to fetch (-u).');
  }

  return hasUrl ? 'fetch' : 'search';
}

export function validateUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Fetch URL must start with http:// or https://, got: ${trimmed}`);
  }
  return trimmed;
}

export async function runSearch(options: RunSearchOptions): Promise<RunSearchResult> {
  const startedAt = Date.now();
  const query = options.query?.trim() || undefined;
  const url = options.url?.trim() ? validateUrl(options.url) : undefined;
  const mode = resolveMode(query, url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfigFile();

  const plans = planRun({
    mode,
    query,
    config,
    requestedEngine: options.engine,
    requestedSources: options.sources === undefined ? undefined : parseSources(options.sources),
    env,
    cooldown: options.cooldown
      ? { state: options.cooldown.state, now: options.cooldown.now }
      : undefined,
  });

  const deadline =
    options.deadlineMs === undefined
      ? undefined
      : {
          at: (options.deadlineStartedAt ?? startedAt) + options.deadlineMs,
          ms: options.deadlineMs,
        };
  const context = { mode, query, url, timeoutMs, deadline, config, env, options };

  // 融合模式并发跑所有合格引擎，再把它们的列表融合起来。
  // 链式模式是原有行为，保持逐字节不变。
  // 抓取永不融合：它返回一个页面，把两个引擎对它的渲染合并起来是另一个产品。
  //
  // 融合会替换 web 条目，而链式那边绝不能再去跑它：一次
  // `--source web,x` 运行否则会把公共索引查两遍，为同一个答案
  // 花掉双倍配额。所以只要融合作答了，web 计划就从链式里摘掉，
  // 只有在融合没答上来时才放回去。
  let fusedWeb: SourceResult | undefined;
  let chainPlans = plans;
  if (mode === 'search' && aggregateMode(config) === 'rrf') {
    fusedWeb = await runFused(config, env, query, timeoutMs, options);
    if (fusedWeb !== undefined) {
      chainPlans = plans.filter((plan) => plan.source !== 'web');
    }
    // 没有任何引擎够格参与融合（都退出了，或者都在冷却），于是
    // 运行落回链式，而不是给出空答案。
  }

  // 并发跑每个来源的计划，再按请求顺序重新组装，这样一次
  // web,x 运行花的时间约等于最慢来源的耗时，而不是它们的总和。
  // Promise.all 无论谁先完成都保持下标顺序。
  const results = await Promise.all(
    chainPlans.map((plan) =>
      runOneSource(plan, context).catch((error): SourceResult => {
        // 单来源运行保持它原有的精确行为：失败照原样传播、CLI 退出。
        // 多于一个来源时，一个来源失败不能把其他来源一起拖垮，所以它变成
        // 一条显式的 unavailable 条目，与路由层自己的 unavailable 语义一致。
        if (chainPlans.length === 1) {
          throw error;
        }
        return failedSourceEntry(plan, error);
      }),
    ),
  );

  return {
    mode,
    query: query ?? null,
    url: url ?? null,
    // 融合答案占据最前面的 web 槽位；其余每个来源
    // 保留链式为它产出的东西。没有融合时，这份列表就完全
    // 是链式自己那份。
    results: fusedWeb === undefined ? results : [fusedWeb, ...results],
    meta: {
      generatedAt: new Date().toISOString(),
      durationSeconds: (Date.now() - startedAt) / 1000,
    },
  };
}

/**
 * 融合路径：把所有合格搜索引擎一次性跑完，再按倒数排名把它们的列表融合起来。
 *
 * 资格判定放在这里而不是路由层，因为三条排除规则含义各不相同，
 * 而路由层只认得其中一条：
 *
 * - `enabled: false` —— 用户把这个引擎关掉了。
 * - `expose.aggregate: false` —— 这个引擎只保留为独立工具。
 * - 冷却中 —— 它的配额已经用尽，现在调用只会失败。这种情况上报为
 *   「跳过」而不是「失败」：没有任何东西坏掉。
 *
 * 显式 `--engine` 把这次运行钉死在那一个引擎上，而按定义它不可能是一次融合，
 * 所以这里返回 undefined，交给链式那条路去服务它。
 * 只要没有任何引擎合格就返回 undefined，让调用方落回链式，
 * 而不是用一个空结果作答。
 */
async function runFused(
  config: ModsearchConfig,
  env: NodeJS.ProcessEnv,
  query: string | undefined,
  timeoutMs: number,
  options: RunSearchOptions,
): Promise<SourceResult | undefined> {
  if (query === undefined || options.engine !== undefined) {
    return undefined;
  }
  if (options.sources !== undefined && !parseSources(options.sources).includes('web')) {
    return undefined;
  }

  const controller = options.cooldown;
  const targets: FanoutTarget[] = [];
  const skipped: string[] = [];

  for (const engine of allEngines()) {
    if (!engine.roles.includes('search') || engine.execute === undefined) {
      continue;
    }
    const settings = engineSettings(engine.name, config, env);
    if (settings.enabled === false) {
      continue;
    }
    if (!exposeOf(settings).aggregate) {
      continue;
    }
    if (!engine.isAvailable(settings, env, 'search')) {
      continue;
    }
    const keyCount = splitApiKeys(settings.apiKey).length;
    // 这里必须用 `coolingEngineEntry`，不能改用 `coolingEntry`：后者接受的
    // 是密钥下标，拿「第 2 个密钥」去问一个只有两个密钥的引擎，查的是一个
    // 通常并不存在的状态键，于是处于冷却的引擎会照样混进融合运行。
    // 而这个函数问的是路由层问的那个问题：这个引擎的任意一个密钥在冷却吗？
    if (controller && coolingEngineEntry(controller.state, engine.name, keyCount, controller.now)) {
      skipped.push(`${engine.name}: 处于冷却期，本次未参与（配额恢复后自动回归）`);
      continue;
    }
    targets.push({ engine, settings });
  }

  if (targets.length === 0) {
    return undefined;
  }

  const startedAt = Date.now();
  const request = {
    mode: 'search' as const,
    query,
    maxResults: options.maxResults,
    timeoutMs,
    settings: {},
    allowPrivateNetwork: options.allowPrivateNetwork === true || config.allowPrivateNetwork === true,
  };
  const budgetMs = aggregateDeadlineMs(config);
  // 重复的查询会真实消耗免密钥引擎的额度（Firecrawl 的每月额度、
  // You.com 的每日每 IP 配额），而智能体在收窄问题的过程中往往会把
  // 同一句话问两遍。一份短期的磁盘缓存能把第二次提问变成一次磁盘读取。
  //
  // 缓存键里包含引擎集合，因为不同的集合就是不同的答案；
  // 它不包含引擎顺序，因为那是路由，不是问题本身。
  const cachePath = currentCachePath();
  const cacheTtl = aggregateCacheTtlMs(config);
  const key = cacheKey({
    query: query ?? '',
    maxResults: request.maxResults ?? 10,
    engines: targets.map((t) => t.engine.name),
  });
  const cached = readCache(cachePath, key, new Date(), cacheTtl);
  if (cached !== undefined && Array.isArray(cached.items)) {
    return buildFusedResult({
      items: cached.items as Array<Record<string, unknown>>,
      engines: cached.engines ?? targets.map((t) => t.engine.name),
      failures: cached.failures ?? [],
      skipped,
      durationSeconds: 0,
      fromCache: true,
    });
  }
  let fanoutResult: Awaited<ReturnType<typeof fanout>>;
  try {
    fanoutResult = await fanout<{
      title: string;
      url: string;
      snippet: string;
    }>(targets, request, budgetMs, AbortSignal.timeout(budgetMs), { skipped });
  } catch (error) {
    // 所有引擎都失败了。直接抛出去，而不是把运行交回给链式：链式会
    // 为同一个失败把同样的引擎再查一遍，花掉双倍配额，换来的只是
    // 我们手里这条错误的另一种说法。fanout 的消息会点名每个来源及其
    // 原因，而链式的消息也是这么做的。
    throw error;
  }
  const { outputs, failures } = fanoutResult;
  const fused = rrfFuse(outputs);
  const enginesUsed = outputs.map((o) => o.engine);

  // 在作答前把融合结果写进缓存。写入失败只意味着下一次
  // 同样的查询又要再花配额，并不代表答案有错，所以这个
  // 错误被吞掉，而不是上报出去。
  try {
    writeCache(
      cachePath,
      key,
      {
        summary:
          fused.length > 0
            ? `Fused ${fused.length} result(s) from ${enginesUsed.length} engine(s).`
            : '',
        items: fused as unknown as Array<Record<string, unknown>>,
        storedAt: new Date().toISOString(),
        engines: enginesUsed,
        failures,
      },
      new Date(),
      CACHE_ENTRY_CAP,
    );
    pruneCache(cachePath, new Date(), cacheTtl, CACHE_ENTRY_CAP);
  } catch {
    // 答案本身不受影响；理由见上。
  }

  return buildFusedResult({
    items: fused as unknown as Array<Record<string, unknown>>,
    engines: enginesUsed,
    failures,
    skipped,
    durationSeconds: (Date.now() - startedAt) / 1000,
    fromCache: false,
    query,
  });
}

/**
 * 组装一次融合运行作答所用的条目。
 *
 * 只用一个函数，好让缓存重放与新鲜运行不会在措辞上跑偏；
 * 调用方看到的唯一差别，就是重放没有花时间。
 */
function buildFusedResult(input: {
  items: Array<Record<string, unknown>>;
  engines: string[];
  failures: string[];
  skipped: string[];
  durationSeconds: number;
  fromCache: boolean;
  query?: string;
}): SourceResult {
  const { items, engines, failures, skipped, durationSeconds, fromCache, query } = input;
  const multiSource = items.filter((item) => {
    const found = item.foundIn;
    return Array.isArray(found) && found.length > 1;
  }).length;
  const cacheNote = fromCache ? ' (served from a cached fusion)' : '';
  const summary =
    items.length > 0
      ? `Fused ${items.length} result(s) from ${engines.length} engine(s) (${engines.join(', ')})${query === undefined ? '' : ` for "${query}"`}.${
          multiSource > 0 ? ` ${multiSource} result(s) were returned by more than one engine.` : ''
        }${cacheNote} Read items for the sources; each item's foundIn names the engines that returned it.`
      : '';

  return {
    source: 'web',
    requestedSource: 'web',
    engine: engines.join(','),
    status: failures.length > 0 ? 'degraded' : 'ok',
    summary,
    items,
    uncertainty: [...failures, ...skipped],
    warnings: items.length === 0 ? ['No results were returned by any of the eligible engines.'] : [],
    attempts: [],
    durationSeconds,
  };
}

async function runOneSource(
  plan: SourcePlan,
  context: {    mode: RunMode;
    query?: string;
    url?: string;
    timeoutMs: number;
    deadline?: RunDeadline;
    config: ModsearchConfig;
    env: NodeJS.ProcessEnv;
    options: RunSearchOptions;
  },
): Promise<SourceResult> {
  const { mode, query, url, timeoutMs, deadline, config, env, options } = context;

  // 这个来源被请求了，但没有任何东西能服务它。返回一条显式的
  // 空条目，而不是把这个槽位丢掉，这样调用方能看到它确实被请求过，
  // 并且是有意地空着回来的。
  if (plan.unavailable) {
    return {
      source: plan.source,
      requestedSource: plan.source,
      engine: null,
      status: 'unavailable',
      summary: '',
      items: [],
      // 路由层的备注（比如 X 降级的告诫）说的是路由，不是事实，
      // 所以它们归入 warnings。什么都没跑，所以没有 attempts。
      uncertainty: [],
      warnings: plan.notes,
      attempts: [],
      durationSeconds: null,
    };
  }

  const candidates = [plan.engine, ...plan.fallbacks].filter(Boolean) as SearchEngine[];

  if (candidates.length === 0) {
    const base = noEngineMessage(SOURCE_ROLE[plan.source] === 'social' ? 'social' : mode);
    // --engine 拼错了才是真正的问题：不要把它埋进泛泛的安装建议里。
    throw new SourceRunError(plan.notes.length > 0 ? `${plan.notes.join(' ')}\n${base}` : base, []);
  }

  const controller = options.cooldown;
  const failures: string[] = [];
  const attempts: EngineAttempt[] = [];
  // 这次运行的全局网络策略：配置里的顶层开关，或者
  // --allow-private-network 这个仅对本次运行生效的一次性覆盖。
  const allowPrivateNetwork =
    options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  // 关于本次运行中撞上配额墙的引擎的说明，挂在最终作答的那个来源上，
  // 让读者看到谁现在在冷却、冷却到什么时候。
  const cooldownNotes: string[] = [];
  for (const engine of candidates) {
    const failuresBeforeEngine = failures.length;
    const settings = engineSettings(engine.name, config, env);
    const model = options.model || settings.model || engine.defaultModel;
    const apiKeys = splitApiKeys(settings.apiKey);
    const configuredKeyRuns =
      apiKeys.length > 0
        ? apiKeys.map((apiKey, keyIndex) => ({ apiKey, keyIndex }))
        : [{ apiKey: undefined, keyIndex: undefined }];
    const keyRuns = controller
      ? [
          ...configuredKeyRuns.filter(
            (run) =>
              run.keyIndex === undefined ||
              !coolingEntry(controller.state, engine.name, controller.now, run.keyIndex),
          ),
          ...configuredKeyRuns.filter(
            (run) =>
              run.keyIndex !== undefined &&
              coolingEntry(controller.state, engine.name, controller.now, run.keyIndex),
          ),
        ]
      : configuredKeyRuns;

    let output: EngineOutput | undefined;
    let successfulStartedAt = 0;
    let successfulKeyIndex: number | undefined;
    for (let runIndex = 0; runIndex < keyRuns.length; runIndex += 1) {
      const keyRun = keyRuns[runIndex];
      const budget = attemptBudget(timeoutMs, deadline);
      if (!budget) {
        // 运行时间用完了：把这个引擎记成跳过，而不是启动它，
        // 这样记录里显示的是截止时间，而不是一段无声的空白。
        const message = `skipped: the run deadline of ${deadline?.ms} ms was used up before it could start.`;
        failures.push(`${engine.name}: ${message}`);
        attempts.push({ engine: engine.name, ok: false, error: message, durationSeconds: null });
        break;
      }
      const startedAt = Date.now();
      try {
        output = await callEngine(
          engine,
          {
            mode,
            query,
            url,
            model,
            maxResults: options.maxResults,
            extraPrompt: options.prompt,
            workdir: options.workdir,
            timeoutMs: budget.engineTimeoutMs,
            settings: { ...settings, apiKey: keyRun.apiKey },
            apiKeySecrets: apiKeys,
            allowPrivateNetwork,
          },
          budget.killAfterMs,
        );
        successfulStartedAt = startedAt;
        successfulKeyIndex = keyRun.keyIndex;
        break;
      } catch (error) {
        // 引擎会自行脱敏自己的错误，但 attempts 与 warnings 会进入
        // 输出与模型上下文，所以这份记录也再脱敏一遍兜底。
        const message = redactSecrets(
          error instanceof Error ? error.message : String(error),
          apiKeys,
        );
        const keyLabel = apiKeys.length > 1 ? ` (API key ${Number(keyRun.keyIndex) + 1})` : '';
        failures.push(`${engine.name}${keyLabel}: ${message}`);
        attempts.push({
          engine: engine.name,
          ...(apiKeys.length > 1 ? { keyIndex: keyRun.keyIndex } : {}),
          ok: false,
          error: message,
          durationSeconds: (Date.now() - startedAt) / 1000,
        });
        // 会记住那些持续性的失败（配额、区域锁定），好让后续运行
        // 优先跳过它们。暂时性的失败（限流、超时）什么也不记。
        if (controller) {
          const entry = controller.record(engine.name, error, keyRun.keyIndex);
          if (entry) {
            const keyNote = keyRun.keyIndex === undefined ? '' : ` API key ${keyRun.keyIndex + 1}`;
            cooldownNotes.push(
              `The ${engine.name} engine${keyNote} hit a lasting limit (quota or region) and is now cooling until ${entry.until}.`,
            );
          }
        }
        const hasNextKey = runIndex + 1 < keyRuns.length;
        if (hasNextKey && isApiKeyFailure(error)) {
          continue;
        }
        break;
      }
    }

    if (!output) {
      continue;
    }

    const durationSeconds = (Date.now() - successfulStartedAt) / 1000;
    // 把引擎自己的花费（exa 的美元、firecrawl 的额度）显示在
    // 有尝试记录时，附上它。否则编排层会把它丢掉。
    attempts.push({
      engine: engine.name,
      ...(apiKeys.length > 1 ? { keyIndex: successfulKeyIndex } : {}),
      ok: true,
      durationSeconds,
      ...engineSpend(output.meta.usage),
    });
    // 这个引擎作答了，所以清掉它之前携带的任何冷却状态。
    controller?.clear(engine.name, successfulKeyIndex);

    // 路由与运行期警告，与引擎自身的认识论不确定性分开。
    // 配置笔误与降级告诫随计划一起走。
    const warnings = [...plan.notes, ...cooldownNotes, ...(controller?.warnings ?? [])];
    if (failures.length > 0) {
      const rotatedWithinEngine =
        failuresBeforeEngine === 0 &&
        failures.length > failuresBeforeEngine &&
        successfulKeyIndex !== undefined;
      warnings.push(
        rotatedWithinEngine && successfulKeyIndex !== undefined
          ? `Rotated to ${engine.name} API key ${successfulKeyIndex + 1} after: ${failures.join(' | ')}`
          : `Fell back to ${engine.name} after: ${failures.join(' | ')}`,
      );
      // 网页引擎应答一个 X 请求时，无论 X 引擎是不存在还是运行中死掉，
      // 这份证据都是二手的。
      if (plan.degradeNote && !engine.roles.includes('social')) {
        warnings.push(plan.degradeNote);
      }
    }

    // 这个答案真正来自哪个语料库。一个由网页引擎服务的 X 计划
    // （Grok 缺失或已死）属于二手网页数据：标成 `web`，并给出
    // `status: "degraded"`，免得有人把它当成对 X 的覆盖。由社交引擎
    // 应答一个 X 计划，那才是真东西。
    const requestedSource = plan.source;
    let actualSource: Source = plan.source;
    let status: SourceStatus = 'ok';
    if (plan.source === 'x' && !engine.roles.includes('social')) {
      actualSource = 'web';
      status = 'degraded';
    }

    const body =
      output.result && typeof output.result === 'object'
        ? ({ ...output.result } as Record<string, unknown>)
        : ({ result: output.result } as Record<string, unknown>);

    // 本地引擎会把自己的运行期通告作为 `warnings` 交回。把它们合并
    // 排在路由类之后。其他引擎不产出 warnings 键。
    const engineWarnings = Array.isArray(body.warnings)
      ? (body.warnings as unknown[]).filter((line): line is string => typeof line === 'string')
      : [];

    // 路由事实与 warnings/attempts 通道由 modsearch 打标，
    // 绝不能由引擎来打：把引擎用这些名字返回的任何键剥掉，
    // 让它没法改写「谁作答的」，也没法伪造一条路由警告。
    delete body.source;
    delete body.requestedSource;
    delete body.engine;
    delete body.model;
    delete body.status;
    delete body.durationSeconds;
    delete body.warnings;
    delete body.attempts;

    return {
      ...body,
      source: actualSource,
      requestedSource,
      engine: engine.name,
      model,
      status,
      warnings: [...warnings, ...engineWarnings],
      attempts,
      durationSeconds,
    };
  }

  throw new SourceRunError(
    `Every engine for the ${plan.source} source failed.\n${failures.map((line) => `  - ${line}`).join('\n')}`,
    attempts,
  );
}

/** 全轮截止时间：它在什么时候落下，以及它来自哪份预算。 */
interface RunDeadline {
  at: number;
  ms: number;
}

/**
 * 一次尝试允许花的时间：引擎自身的超时，以及运行不再等待一个无视该超时
 * 的引擎的那个时刻（到点就杀掉子进程）。两者都受运行截止时间剩余量的
 * 限制。截止时间已经用完时返回 null。
 */
function attemptBudget(
  timeoutMs: number,
  deadline: RunDeadline | undefined,
): { engineTimeoutMs: number; killAfterMs: number } | null {
  if (!deadline) {
    return { engineTimeoutMs: timeoutMs, killAfterMs: timeoutMs + KILL_GRACE_MS };
  }
  // 取整毫秒：起始时钟可能带小数，而这个值会被交给
  // AbortSignal.timeout，它不接受小数延迟。
  const remaining = Math.floor(deadline.at - Date.now());
  if (remaining <= 0) {
    return null;
  }
  return {
    engineTimeoutMs: Math.min(timeoutMs, remaining),
    killAfterMs: Math.min(timeoutMs + DEADLINE_KILL_GRACE_MS, remaining),
  };
}

async function callEngine(
  engine: SearchEngine,
  request: EngineRequest,
  killAfterMs: number,
): Promise<EngineOutput> {
  if (engine.execute) {
    return withinTime(engine.name, engine.execute(request), killAfterMs);
  }
  if (engine.buildInvocation && engine.parseOutput) {
    const invocation = engine.buildInvocation(request);
    const commandResult = await runCommand(
      engine.name,
      invocation,
      killAfterMs,
      engine.describeFailure,
    );
    return engine.parseOutput(commandResult.stdout);
  }
  throw new Error(`Engine ${engine.name} implements neither execute nor buildInvocation.`);
}

/**
 * 停止等待一个超出自身超时的进程内引擎。引擎都会按时取消自己的请求，
 * 所以这里只会在引擎出 bug 时触发，并且能防止这个 bug 把整次运行
 * 拖过它的截止时间。
 */
async function withinTime<T>(engineName: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const overrun = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${engineName} engine timed out after ${ms} ms.`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, overrun]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 这台机器上没有任何东西能干这件事。说清怎么才能修好，每个引擎一行，
 * 而不是只点名某一个依赖，仿佛它是必需的。
 */
export function noEngineMessage(role: 'search' | 'fetch' | 'social'): string {
  const options = enginesForRole(role)
    .map((engine) => `  - ${engine.name}: ${engine.requirement}`)
    .join('\n');
  const job = role === 'fetch' ? 'fetch a page' : role === 'social' ? 'search X' : 'search the web';
  return `No engine on this machine can ${job}. Any one of these enables it:\n${options}`;
}
