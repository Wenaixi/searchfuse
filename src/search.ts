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
  /** Engine override for this run, e.g. `tavily`. */
  engine?: string;
  /** Source list, e.g. `web,x`. Undefined decides from the query. */
  sources?: string;
  model?: string;
  prompt?: string;
  /** Per-engine budget: each attempt gets this long. */
  timeoutMs?: number;
  /**
   * Wall-clock budget for the whole run, counted from its start. Each attempt
   * gets the smaller of `timeoutMs` and what is left, and an engine whose turn
   * comes after the budget is spent is skipped. Absent means no run-wide cap,
   * so a chain of N engines may take up to N times `timeoutMs`.
   */
  deadlineMs?: number;
  /**
   * Epoch milliseconds the deadline counts from. Defaults to the start of this
   * run. The CLI passes its process start, so Node startup and config loading
   * come out of the same budget the caller is holding.
   */
  deadlineStartedAt?: number;
  maxResults?: number;
  workdir?: string;
  /** One-off override for the local engine's private network guard. */
  allowPrivateNetwork?: boolean;
  /** Injected config, for tests. Loaded from ~/.modsearch/config.json otherwise. */
  config?: ModsearchConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Quota cooldown for this run: orders the chain away from spent engines and
   * records or clears their state as the run plays out. Absent means the
   * cooldown is off (the switch, or a caller that does not use it), and routing
   * is exactly as it was before cooldowns existed.
   */
  cooldown?: CooldownController;
}

/** How well this entry served the source that was requested. */
export type SourceStatus = 'ok' | 'degraded' | 'unavailable';

/** One try at one engine, in the order they were attempted. */
export interface EngineAttempt {
  engine: string;
  /** Zero-based configured key index. Present only when an engine has multiple keys. */
  keyIndex?: number;
  /** True when the engine returned a result, false when it failed or was skipped. */
  ok: boolean;
  /** Present only when `ok` is false: the failure message. */
  error?: string;
  /** How long this attempt took, or null when nothing ran. */
  durationSeconds: number | null;
  /** US-dollar cost this attempt reported, where the engine tracks one (exa). Absent otherwise. */
  cost?: number;
  /** Credits this attempt spent, where the engine tracks them (firecrawl). Absent otherwise. */
  credits?: number;
}

/** The spend an engine reported on its usage: exa dollars, firecrawl credits. */
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

/** One source's answer. Engine result fields are flattened in beside them. */
export interface SourceResult {
  /** The corpus this entry actually came from. May differ from requestedSource. */
  source: Source;
  /** The corpus that was asked for. Equals `source` unless the run degraded. */
  requestedSource: Source;
  /** Which engine answered, or null when the source was unreachable. */
  engine: string | null;
  model?: string;
  /**
   * `ok`: served the requested source. `degraded`: a stand-in corpus answered
   * (e.g. the web answering an X request, so it is second-hand). `unavailable`:
   * nothing could serve the source, and `items` is empty.
   */
  status: SourceStatus;
  /**
   * Routing and runtime warnings for this source: an engine that failed and was
   * replaced, a degrade to a stand-in corpus, a config typo, the local engine's
   * "no synthesis" and "private network allowed" notices. These are about how
   * the answer was produced, not about the facts in it.
   */
  warnings: string[];
  /** Every engine tried for this source, in order, with per-try outcome. */
  attempts: EngineAttempt[];
  durationSeconds: number | null;
  [resultField: string]: unknown;
}

export interface RunSearchResult {
  mode: RunMode;
  query: string | null;
  url: string | null;
  /** Always an array, one entry per source, so the shape never changes. */
  results: SourceResult[];
  meta: {
    generatedAt: string;
    durationSeconds: number;
  };
}

/** Ceiling on cached fusions, so the file stays bounded without a background job. */
const CACHE_ENTRY_CAP = 100;

const DEFAULT_TIMEOUT_MS = 180_000;
// 先给引擎自己的超时一个开火的机会；SIGTERM 只是兜底。
const KILL_GRACE_MS = 30_000;
// 在有运行截止时间的情况下宽限期很短，所以一个无视自身超时的引擎
// timeout cannot spend the time a fallback engine was meant to have.
const DEADLINE_KILL_GRACE_MS = 5_000;

/**
 * A source ran out of engines. Carries the per-engine attempts so a multi-source
 * run can surface them in the source's `attempts` instead of losing them to the
 * throw. Its message is unchanged from the old plain Error, so the single-source
 * path (which lets this reach the CLI) prints exactly what it always did.
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

/** Turn a source that exhausted its engines into an explicit unavailable entry. */
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
  // 链式模式是原有行为，保持逐字节不变
  // below. Fetch never fuses: it returns one page, and merging two engines'
  // renderings of it would be a different product.
  if (mode === 'search' && aggregateMode(config) === 'rrf') {
    const fused = await runFused(config, env, query, timeoutMs, options);
    if (fused !== undefined) {
      return {
        mode,
        query: query ?? null,
        url: null,
        results: [fused],
        meta: {
          generatedAt: new Date().toISOString(),
          durationSeconds: (Date.now() - startedAt) / 1000,
        },
      };
    }
    // 没有任何引擎够格参与融合（都退出了，或者都在冷却），于是
    // run falls through to the chain rather than answering empty.
  }

  // 并发跑每个来源的计划，再按请求顺序重新组装，这样
  // web,x run costs about the time of its slowest source, not their sum.
  // Promise.all preserves index order regardless of which settled first.
  const results = await Promise.all(
    plans.map((plan) =>
      runOneSource(plan, context).catch((error): SourceResult => {
        // A single-source run keeps its exact prior behavior: the failure
        // propagates and the CLI exits. With more than one source, one source
        // failing must not sink the others, so it becomes an explicit
        // unavailable entry, matching the router's own unavailable semantics.
        if (plans.length === 1) {
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
    results,
    meta: {
      generatedAt: new Date().toISOString(),
      durationSeconds: (Date.now() - startedAt) / 1000,
    },
  };
}

/**
 * The fused path: run every eligible search engine at once and merge their
 * lists by reciprocal rank.
 *
 * Eligibility is decided here rather than by the router, because the three
 * exclusions mean different things and the router only knows about one of
 * them:
 *
 * - `enabled: false` — the user turned this engine off.
 * - `expose.aggregate: false` — the engine is kept as a standalone tool only.
 * - cooling — its quota is spent, so calling it now would only fail. It is
 *   reported as skipped rather than failed: nothing broke.
 *
 * An explicit `--engine` pins the run to that one engine, which cannot be a
 * fusion by definition, so it returns undefined and the chain serves it.
 * Returning undefined whenever nothing qualifies lets the caller fall through
 * to the chain instead of answering with an empty result.
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
    // coolingEngineEntry, not coolingEntry: the latter takes a key INDEX and
    // asking it about "key 2" on an engine with two keys queries a state key
    // that usually does not exist, so a cooling engine would slip into the
    // fused run anyway. This one asks the question the router asks: is any key
    // of this engine cooling?
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
  // 重复的查询会真实消耗免密钥引擎的额度（Firecrawl 的
  // monthly credits, You.com's daily per-IP allowance), and an agent often
  // asks the same thing twice while narrowing a problem. A short disk cache
  // turns that second ask into a disk read.
  //
  // 键里包含引擎集合，因为不同的集合就是不同的
  // answer; it excludes engine order because that is routing, not the
  // question.
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
  } catch {
    // 所有引擎都失败了。这里交回给链式而不是抛错
    // here keeps one behavior for "nothing worked": the chain raises the
    // error the user already knows, naming the source and each engine's
    // attempt. A second, differently worded total-failure message from the
    // fused path would be a worse error for the same situation.
    return undefined;
  }
  const { outputs, failures } = fanoutResult;
  const fused = rrfFuse(outputs);
  const enginesUsed = outputs.map((o) => o.engine);

  // 在作答前把融合结果写进缓存。写入失败只意味着
  // second query costs quota again, not that the answer is wrong, so the
  // error is swallowed rather than surfaced.
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
 * Assemble the entry a fused run answers with.
 *
 * One function so a cached replay and a fresh run cannot drift apart in
 * wording; the only difference the caller sees is that a replay took no time.
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

  // 这个来源被请求了，但没有任何东西能服务它。返回一个显式的
  // empty entry rather than dropping the slot, so a consumer sees it was
  // requested and came back empty on purpose.
  if (plan.unavailable) {
    return {
      source: plan.source,
      requestedSource: plan.source,
      engine: null,
      status: 'unavailable',
      summary: '',
      items: [],
      // The router's notes (e.g. the X-degrade caveat) are about routing, not
      // facts, so they belong in warnings. Nothing ran, so no attempts.
      uncertainty: [],
      warnings: plan.notes,
      attempts: [],
      durationSeconds: null,
    };
  }

  const candidates = [plan.engine, ...plan.fallbacks].filter(Boolean) as SearchEngine[];

  if (candidates.length === 0) {
    const base = noEngineMessage(SOURCE_ROLE[plan.source] === 'social' ? 'social' : mode);
    // A typo in --engine is the actual problem: do not bury it under generic
    // setup advice.
    throw new SourceRunError(plan.notes.length > 0 ? `${plan.notes.join(' ')}\n${base}` : base, []);
  }

  const controller = options.cooldown;
  const failures: string[] = [];
  const attempts: EngineAttempt[] = [];
  // 这次运行的全局网络策略：配置里的顶层开关，或者
  // --allow-private-network flag as a one-off override for this run.
  const allowPrivateNetwork =
    options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  // 关于本次运行中撞上配额墙的引擎的说明，放在
  // that finally answers so the reader sees who is now cooling and until when.
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
        // 运行时间用完了：把这个引擎记成跳过，而不是
        // starting it, so the trail shows the deadline, not a silent gap.
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
        // output and model contexts, so the record gets the belt too.
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
        // fails over first. A transient one (rate limit, timeout) records nothing.
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
    // attempt, when it reported any. The orchestrator otherwise drops it.
    attempts.push({
      engine: engine.name,
      ...(apiKeys.length > 1 ? { keyIndex: successfulKeyIndex } : {}),
      ok: true,
      durationSeconds,
      ...engineSpend(output.meta.usage),
    });
    // 这个引擎作答了，所以清掉它之前携带的任何冷却状态。
    controller?.clear(engine.name, successfulKeyIndex);

    // 路由与运行期警告，与引擎的认识论性
    // uncertainty. Config typos and degrade caveats travel on the plan.
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
    // (Grok missing or dead) is second-hand web data: label it `web` with
    // `status: "degraded"` so nobody reads it as X coverage. A social engine
    // answering an X plan is the real thing.
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
    // those in after the routing ones. Other engines emit no warnings key.
    const engineWarnings = Array.isArray(body.warnings)
      ? (body.warnings as unknown[]).filter((line): line is string => typeof line === 'string')
      : [];

    // 路由事实与 warnings/attempts 通道由 modsearch 打标，
    // never by the engine: strip any key the engine returned with these names so
    // it cannot rewrite who answered or forge a routing warning.
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

/** The run-wide deadline: when it falls, and the budget it came from. */
interface RunDeadline {
  at: number;
  ms: number;
}

/**
 * The time one attempt may take: the engine's own timeout, and the moment the
 * run stops waiting on an engine that ignores it (a subprocess is killed then).
 * Both are capped by what the run deadline has left. Null when the deadline is
 * already spent.
 */
function attemptBudget(
  timeoutMs: number,
  deadline: RunDeadline | undefined,
): { engineTimeoutMs: number; killAfterMs: number } | null {
  if (!deadline) {
    return { engineTimeoutMs: timeoutMs, killAfterMs: timeoutMs + KILL_GRACE_MS };
  }
  // 取整毫秒：起始时钟可能带小数，而引擎交回的
  // this to AbortSignal.timeout, which rejects a fractional delay.
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
 * Stop waiting on an in-process engine that overran its own timeout. Engines
 * cancel their own requests on time, so this only fires on an engine bug, and
 * it keeps that bug from holding the run past its deadline.
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
 * Nothing on this machine can do this job. Say what would fix it, one line per
 * engine, instead of naming a single dependency as if it were mandatory.
 */
export function noEngineMessage(role: 'search' | 'fetch' | 'social'): string {
  const options = enginesForRole(role)
    .map((engine) => `  - ${engine.name}: ${engine.requirement}`)
    .join('\n');
  const job = role === 'fetch' ? 'fetch a page' : role === 'social' ? 'search X' : 'search the web';
  return `No engine on this machine can ${job}. Any one of these enables it:\n${options}`;
}
