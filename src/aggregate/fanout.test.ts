import { describe, expect, it } from 'vitest';
import { fanout } from './fanout.ts';

interface Box {
  summary: string;
  items: Array<{ title: string; url: string; snippet: string }>;
}
const box = (summary: string, urls: string[]): Box => ({
  summary,
  items: urls.map((url, i) => ({ title: `t${i}`, url, snippet: `s${i}` })),
});

function target(name: string, impl: () => Promise<unknown>, options: { delayMs?: number } = {}) {
  return {
    engine: {
      name,
      execute: async () => {
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        return { result: await impl() };
      },
    } as never,
    settings: {} as never,
  };
}

const request = { mode: 'search' as const, query: 'q', timeoutMs: 5_000 } as never;

describe('fanout', () => {
  it('runs every target and returns all their lists', async () => {
    const { outputs, failures } = await fanout(
      [
        target('a', async () => box('a', ['https://a.example/1'])),
        target('b', async () => box('b', ['https://b.example/1'])),
      ],
      request,
      5_000,
      new AbortController().signal,
    );
    expect(outputs.map((o) => o.engine)).toEqual(['a', 'b']);
    expect(failures).toEqual([]);
  });

  it('returns what succeeded when one target fails', async () => {
    // Partial success is the contract: one broken engine must not cost the
    // user every other source's answer.
    const { outputs, failures } = await fanout(
      [
        target('a', async () => box('a', ['https://a.example/1'])),
        target('b', async () => {
          throw new Error('tavily: 401 invalid key');
        }),
        target('c', async () => box('c', ['https://c.example/1'])),
      ],
      request,
      5_000,
      new AbortController().signal,
    );
    expect(outputs.map((o) => o.engine)).toEqual(['a', 'c']);
    expect(failures).toEqual(['b: tavily: 401 invalid key']);
  });

  it('reports which sources were skipped rather than calling them failures', async () => {
    // A source held out of the run by the caller is not a failure: the caller
    // decides why, and the wording has to be able to say so.
    const { outputs, skipped } = await fanout(
      [target('a', async () => box('a', ['https://a.example/1']))],
      request,
      5_000,
      new AbortController().signal,
      { skipped: ['tavily: 处于冷却期，本次未参与'] },
    );
    expect(outputs).toHaveLength(1);
    expect(skipped).toEqual(['tavily: 处于冷却期，本次未参与']);
  });

  it('stops waiting at the total deadline and records the stragglers', async () => {
    const { outputs, failures } = await fanout(
      [
        target('fast', async () => box('fast', ['https://f.example/1'])),
        target('slow', async () => box('slow', []), { delayMs: 400 }),
      ],
      request,
      50,
      new AbortController().signal,
    );
    expect(outputs.map((o) => o.engine)).toEqual(['fast']);
    expect(failures.join()).toMatch(/slow:.*timed out|slow:.*abort/i);
  });

  it('throws only when every source failed, carrying each failure', async () => {
    await expect(
      fanout(
        [
          target('a', async () => {
            throw new Error('boom a');
          }),
          target('b', async () => {
            throw new Error('boom b');
          }),
        ],
        request,
        5_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/a: boom a[\s\S]*b: boom b|b: boom b[\s\S]*a: boom a/);
  });

  it('throws when there was nothing to run', async () => {
    await expect(fanout([], request, 5_000, new AbortController().signal)).rejects.toThrow(
      /no engine|no source/i,
    );
  });

  it('passes the caller’s abort signal through to each engine', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const capturing = (name: string) =>
      ({
        engine: {
          name,
          execute: async (req: { signal?: AbortSignal }) => {
            seen.push(req.signal);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { result: box(name, []) };
          },
        } as never,
        settings: {} as never,
      }) as never;
    const run = fanout([capturing('a'), capturing('b')], request, 5_000, controller.signal);
    controller.abort();
    await expect(run).rejects.toThrow(/cancel|abort/i);
    // Each engine got a signal, whether the caller's own or a linked one.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((s) => s?.aborted)).toBe(true);
  });
});
