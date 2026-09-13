import { describe, it, expect } from 'vitest';
import { isAnalysisInFlight, lastActivityAt, STALE_PROCESSING_MS } from './entryLock';
import type { Entry } from '../types';

const T0 = Date.parse('2026-09-12T20:40:00.000Z');

function entry(over: Partial<Entry> = {}): Pick<Entry, 'status' | 'actionLog' | 'createdAt'> {
  return {
    status: 'processing',
    createdAt: new Date(T0).toISOString(),
    actionLog: [],
    ...over,
  } as Pick<Entry, 'status' | 'actionLog' | 'createdAt'>;
}

function log(atMs: number, action = 'page_fetched') {
  return { action, details: {}, timestamp: new Date(atMs).toISOString() };
}

describe('lastActivityAt', () => {
  it('falls back to creation when nothing has been logged yet', () => {
    expect(lastActivityAt(entry())).toBe(T0);
  });

  it('takes the latest step, whatever order the log is in', () => {
    const e = entry({ actionLog: [log(T0 + 5_000), log(T0 + 90_000), log(T0 + 20_000)] as never });
    expect(lastActivityAt(e)).toBe(T0 + 90_000);
  });

  // A malformed timestamp must not read as "now" and keep a dead pass alive.
  it('ignores unparseable timestamps', () => {
    const e = entry({ actionLog: [{ action: 'x', details: {}, timestamp: 'boh' }] as never });
    expect(lastActivityAt(e)).toBe(T0);
  });
});

describe('isAnalysisInFlight', () => {
  it('a completed entry is never in flight', () => {
    expect(isAnalysisInFlight(entry({ status: 'completed' }), T0 + 1_000)).toBe(false);
  });

  it('an entry in error is never in flight', () => {
    expect(isAnalysisInFlight(entry({ status: 'error' }), T0 + 1_000)).toBe(false);
  });

  // The real case: two passes fired in the same minute, and the loser
  // overwrote the winner's extraction.
  it('a pass that just wrote a step is in flight', () => {
    const e = entry({ actionLog: [log(T0 + 30_000)] as never });
    expect(isAnalysisInFlight(e, T0 + 40_000)).toBe(true);
  });

  // A long pass (Whisper + OCR + vision) must not be mistaken for a dead one
  // just because it is slow: the clock is the last step, not the start.
  it('a slow pass that keeps logging stays in flight', () => {
    const e = entry({ actionLog: [log(T0 + 14 * 60_000)] as never });
    expect(isAnalysisInFlight(e, T0 + 14 * 60_000 + 60_000)).toBe(true);
  });

  // The other half: a container that died mid-pass leaves the row at
  // `processing` for good, and refusing forever would strand it.
  it('a pass silent past the threshold is treated as dead', () => {
    const e = entry({ actionLog: [log(T0)] as never });
    expect(isAnalysisInFlight(e, T0 + STALE_PROCESSING_MS + 1)).toBe(false);
  });

  it('an entry stuck at processing since creation eventually frees up', () => {
    expect(isAnalysisInFlight(entry(), T0 + STALE_PROCESSING_MS + 1)).toBe(false);
  });
});
