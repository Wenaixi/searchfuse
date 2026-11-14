import { describe, expect, it, vi } from 'vitest';
import { aggregateDeadlineMs, aggregateMode, exposeOf } from './config.ts';

describe('aggregate mode resolution', () => {
  it('fuses by default', () => {
    // The upgrade's whole point: a config written before this setting existed
    // behaves as a fused run, not as a chain.
    expect(aggregateMode({})).toBe('rrf');
    expect(aggregateMode({ aggregate: {} })).toBe('rrf');
  });

  it('honours an explicit chain request', () => {
    expect(aggregateMode({ aggregate: { mode: 'chain' } })).toBe('chain');
  });

  it('ignores an unrecognized mode rather than disabling everything', () => {
    // A hand-edited typo must not silently turn fusion off; the safe reading
    // of a value nobody understands is the default.
    expect(aggregateMode({ aggregate: { mode: 'nonsense' as never } })).toBe('rrf');
  });

  it('defaults the budget to 8 seconds', () => {
    expect(aggregateDeadlineMs({})).toBe(8_000);
    expect(aggregateDeadlineMs({ aggregate: {} })).toBe(8_000);
  });

  it('honours a configured budget and refuses nonsense values', () => {
    expect(aggregateDeadlineMs({ aggregate: { deadlineMs: 3_000 } })).toBe(3_000);
    expect(aggregateDeadlineMs({ aggregate: { deadlineMs: 0 } })).toBe(8_000);
    expect(aggregateDeadlineMs({ aggregate: { deadlineMs: -5 } })).toBe(8_000);
    expect(aggregateDeadlineMs({ aggregate: { deadlineMs: 'soon' as never } })).toBe(8_000);
  });
});

describe('exposeOf', () => {
  it('fuses by default and does not grow a tool unasked', () => {
    // A new engine must not add a tool to the model's tool list by existing.
    expect(exposeOf({})).toEqual({ aggregate: true, tool: false });
    expect(exposeOf({ enabled: true })).toEqual({ aggregate: true, tool: false });
  });

  it('reads an engine kept as a standalone tool only', () => {
    expect(exposeOf({ expose: { aggregate: false, tool: true } })).toEqual({
      aggregate: false,
      tool: true,
    });
  });

  it('reads an engine that does both', () => {
    // Both at once is the point of the matrix: the engine contributes to the
    // fused answer and can still be called by name.
    expect(exposeOf({ expose: { aggregate: true, tool: true } })).toEqual({
      aggregate: true,
      tool: true,
    });
  });

  it('ignores a malformed expose block instead of dropping the engine', () => {
    // A hand-edited config can put a string here. Treating that as "expose
    // nothing" would silently remove an engine from search.
    expect(exposeOf({ expose: 'yes' as never })).toEqual({ aggregate: true, tool: false });
    expect(exposeOf({ expose: [] as never })).toEqual({ aggregate: true, tool: false });
  });

  it('treats a non-boolean aggregate flag as the default', () => {
    expect(exposeOf({ expose: { aggregate: 'no' as never } })).toEqual({
      aggregate: true,
      tool: false,
    });
  });
});
