import type { EngineRequest, SearchEngine } from '../types.ts';
import type { RankedList } from './rrf.ts';

/** 一个要运行的引擎，配置与纳入规则都已经解析好。 */
export interface FanoutTarget {
  engine: SearchEngine;
  settings: EngineRequest['settings'];
}

export interface FanoutOptions {
  /**
   * 调用方故意在这次运行里排除的来源（比如一个正在冷却的引擎）。
   * 它们与真正的失败一起上报，但措辞是「未参与」而不是「失败」，
   * 因为对读者来说这两件事含义不同。
   */
  skipped?: string[];
}

export interface FanoutResult<T> {
  outputs: RankedList<T>[];
  failures: string[];
  skipped: string[];
}

/**
 * 在同一个墙钟预算下，把每个目标一次性跑完。
 *
 * 有两件事比并行本身更重要：
 *
 * 1. **一个来源坏掉只由它自己承担。** 每个目标独立结算，它的拒绝被记成
 *    一条失败记录。用的是 `Promise.allSettled` 而不是 `Promise.all`，
 *    所以一个 401 不会抹掉另外三个健康的答案。
 *
 * 2. **预算是总的，不是单引擎的。** 慢的来源不该因为它碰巧还在跑，
 *    就延长用户的等待。共享信号是调用方的中止信号与截止时间链接起来的，
 *    它触发时还没回来的一律记为失败，融合继续用已经到手的部分往下走。
 *
 * 只有一项都没成功时它才抛错：空答案与「确实没有结果」无法区分，
 * 而每个来源的原因才是可操作的那部分信息。
 */
export async function fanout<T extends { url?: string; snippet?: string }>(
  targets: FanoutTarget[],
  request: Omit<EngineRequest, 'settings'>,
  totalDeadlineMs: number,
  /**
   * 调用方自己的取消信号，**不是**预算。
   *
   * 这两件事必须分开传入。以前签名要求一个必填的 AbortSignal，而
   * `runSearch` 手里没有取消信号，只能把自己的超时信号递进来——于是每一次
   * 预算耗尽都被报成「the run was cancelled」，用户会以为是自己打断了运行。
   * 信息不存在就没法猜，所以这里把它改成明确的「取消」，并允许缺省。
   */
  cancelSignal: AbortSignal | undefined,
  options: FanoutOptions = {},
): Promise<FanoutResult<T>> {
  const skipped = options.skipped ?? [];
  if (targets.length === 0) {
    throw new Error('No engine was available to run. Check engine availability and settings.');
  }

  const deadline = AbortSignal.timeout(totalDeadlineMs);
  const linked =
    cancelSignal === undefined ? deadline : AbortSignal.any([cancelSignal, deadline]);
  // 归因只看这两份精确信息：预算先到是超时，外部先到是取消。
  const cancelledByCaller = () => cancelSignal?.aborted === true && !deadline.aborted;

  // 每个目标让它自己的执行与共享信号赛跑。只等 allSettled 会把整次运行
  // 拖到最慢的引擎结束为止，而这正是总预算必须阻止的：一个无视自身信号的
  // 来源，仍然会拖住其他所有来源的答案。
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
        engine.execute!({ ...request, settings, signal: linked } as unknown as EngineRequest),
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

