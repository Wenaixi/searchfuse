import type { EngineRequest, SearchEngine } from '../providers/index.ts';
import { rrfFuse, type RankedList } from './rrf.ts';

/** One engine to run, already resolved against settings and inclusion rules. */
export interface FanoutTarget {
  engine: SearchEngine;
  settings: EngineRequest['settings'];
}

export interface FanoutOptions {
  /**
   * Sources the caller deliberately left out of this run (a cooling engine,
   * say). Reported alongside real failures but worded as "not run" rather
   * than "failed", because the two mean different things to a reader.
   */
  skipped?: string[];
}

export interface FanoutResult<T> {
  outputs: RankedList<T>[];
  failures: string[];
  skipped: string[];
}

/**
 * Run every target at once, under one wall-clock budget.
 *
 * Two properties matter more than the parallelism itself:
 *
 * 1. **A broken source costs only itself.** Each target settles independently
 *    and its rejection is recorded as a failure line. The result is
 *    `Promise.allSettled`, not `Promise.all`, so one 401 cannot erase three
 *    healthy answers.
 *
 * 2. **The budget is total, not per-engine.** A slow source must not extend
 *    the user's wait just because it happens to still be running. The shared
 *    signal is the caller's abort linked to a deadline, so whatever is left
 *    when it fires is recorded as a failure and the fusion proceeds with
 *    what arrived.
 *
 * Only when nothing succeeded does this throw: an empty answer would be
 * indistinguishable from "no results", and the per-source reasons are the
 * actionable part.
 */
export async function fanout<T extends { url?: string; snippet?: string }>(
  targets: FanoutTarget[],
  request: Omit<EngineRequest, 'settings'>,
  totalDeadlineMs: number,
  signal: AbortSignal,
  options: FanoutOptions = {},
): Promise<FanoutResult<T>> {
  const skipped = options.skipped ?? [];
  if (targets.length === 0) {
    throw new Error('No engine was available to run. Check engine availability and settings.');
  }

  const deadline = AbortSignal.timeout(totalDeadlineMs);
  const linked = AbortSignal.any([signal, deadline]);
  const cancelledByCaller = () => signal.aborted;

  // Each target races its own execution against the shared signal. Waiting on
  // allSettled alone would hold the whole run until the slowest engine
  // finished, which is exactly what a total budget must prevent: a source
  // that ignores its signal would still delay everyone else's answer.
  const raceStop = new Promise<'stopped'>((resolve) => {
    if (linked.aborted) {
      resolve('stopped');
      return;
    }
    linked.addEventListener('abort', () => resolve('stopped'), { once: true });
  });

  const settled = await Promise.all(
    targets.map(async ({ engine, settings }, index) => {
      const execution = Promise.resolve(
        engine.execute!({ ...request, settings, signal: linked } as EngineRequest),
      )
        .then((output) => ({ status: 'fulfilled' as const, output }))
        .catch((reason: unknown) => ({ status: 'rejected' as const, reason }));
      const outcome = await Promise.race([execution, raceStop]);
      return { index, name: engine.name, outcome };
    }),
  );

  const outputs: RankedList<T>[] = [];
  const failures: string[] = [];
  for (const { name, outcome } of settled) {
    if (outcome === 'stopped') {
      failures.push(
        cancelledByCaller()
          ? `${name}: the run was cancelled before this source answered.`
          : `${name}: timed out after ${totalDeadlineMs} ms.`,
      );
      continue;
    }
    if (outcome.status === 'fulfilled') {
      const { result } = outcome.output;
      const items = Array.isArray((result as { items?: unknown })?.items)
        ? ((result as { items: T[] }).items)
        : [];
      outputs.push({ engine: name, items });
      continue;
    }
    const reason = outcome.reason;
    const text = reason instanceof Error ? reason.message : String(reason);
    failures.push(`${name}: ${text}`);
  }

  if (outputs.length === 0) {
    const lines = [...failures, ...skipped];
    const why = cancelledByCaller() ? 'The run was cancelled.' : 'Every engine failed or was skipped, so nothing could be fused.';
    throw new Error(`${why} ${lines.join(' | ')}`);
  }

  return { outputs, failures, skipped };
}

/** Fuse what fanout collected into one ranked list. */
export function fuse<T extends { url?: string; snippet?: string }>(
  outputs: RankedList<T>[],
): Array<T & { score: number; foundIn: string[] }> {
  return rrfFuse(outputs);
}
