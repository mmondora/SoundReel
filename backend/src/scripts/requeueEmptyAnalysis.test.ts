import { describe, expect, it, vi } from 'vitest';
import { fetchEmptyEntries, MIN_TEXT, parseArgs, requeueEmptyAnalysis, type Deps, type EmptyEntry } from './requeueEmptyAnalysis';

const ROWS: EmptyEntry[] = [
  { id: 'e1', source_url: 'https://www.instagram.com/reel/AAA', source_platform: 'instagram', input_user: 'mike', text_chars: 900 },
  { id: 'e2', source_url: 'https://example.com/post', source_platform: 'other', input_user: null, text_chars: 120 },
];

/** A database that answers the entry query with `rows` and the chat query with one chat; remembers the SQL it saw. */
function fakeDeps(rows: EmptyEntry[], over: Partial<Deps> = {}) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      if (sql.includes('FROM job_queue j') || sql.includes('GROUP BY chat_id')) {
        return sql.includes('GROUP BY chat_id') ? { rows: [{ chat_id: '4242' }] } : { rows };
      }
      return { rows };
    }),
  };
  const enqueue = vi.fn(async () => 1);
  const record = vi.fn(async () => undefined);
  const lines: string[] = [];
  const deps: Deps = { db: db as never, enqueue, record, say: (l) => void lines.push(l), ...over };
  return { deps, db, enqueue, record, lines, seen };
}

describe('parseArgs', () => {
  it('defaults: really queue, silent, everything', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, notify: false, since: null, limit: null });
  });

  it('reads the flags', () => {
    expect(parseArgs(['--dry-run', '--notify', '--since', '2026-11-02', '--limit', '3'])).toEqual({
      dryRun: true, notify: true, since: '2026-11-02', limit: 3,
    });
  });

  it('refuses a date that is not YYYY-MM-DD and a limit that is not a positive integer', () => {
    expect(() => parseArgs(['--since', '02/11/2026'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/intero positivo/);
    expect(() => parseArgs(['--limit', 'abc'])).toThrow(/intero positivo/);
    expect(() => parseArgs(['--limit', '2.5'])).toThrow(/intero positivo/);
  });
});

describe('the selection of entries', () => {
  it('asks for completed entries with text and nothing extracted, leaving out the ones that must not be redone', async () => {
    const { db } = fakeDeps(ROWS);
    await fetchEmptyEntries(db as never, { since: null, limit: null });
    const sql = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("e.status = 'completed'");
    expect(sql).toContain("e.source_platform <> 'shazam'"); // library entries are not analysed
    for (const emptyList of ['films', 'notes', 'software']) expect(sql).toContain(`e.results->'${emptyList}'`);
    expect(sql).toContain("'audio_fingerprint'"); // a background track from the audio is not an analysis
    expect(sql).toContain("a->'details'->>'status' = 'empty'"); // Claude already judged these empty
    expect(sql).toContain("j.status IN ('queued', 'processing')"); // already in the queue
  });

  it('passes the text threshold, the date and the limit as parameters, never in the SQL text', async () => {
    const { db } = fakeDeps(ROWS);
    await fetchEmptyEntries(db as never, { since: '2026-11-02', limit: 3 });
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([MIN_TEXT, '2026-11-02', 3]);
    expect(sql).not.toContain('2026-11-02');
  });
});

describe('requeueEmptyAnalysis', () => {
  it('a dry run lists what it would do and changes nothing', async () => {
    const { deps, enqueue, record, lines } = fakeDeps(ROWS);
    const out = await requeueEmptyAnalysis(deps, parseArgs(['--dry-run']));
    expect(out).toEqual({ found: 2, queued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('DRY RUN');
    expect(lines.join('\n')).toContain('e1  instagram  900 char');
  });

  it('re-queues each entry as a silent re-analysis from the data already saved, and records it', async () => {
    const { deps, enqueue, record } = fakeDeps(ROWS);
    const out = await requeueEmptyAnalysis(deps, parseArgs([]));
    expect(out).toEqual({ found: 2, queued: 2 });
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      entryId: 'e1', sourceUrl: 'https://www.instagram.com/reel/AAA', platform: 'instagram', chatId: 4242, inputUser: 'mike', notify: false, reanalyze: true,
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ entryId: 'e2', platform: 'other', inputUser: null, notify: false, reanalyze: true }));
    expect(record).toHaveBeenCalledWith('e1', 'instagram', true);
    expect(record).toHaveBeenCalledWith('e2', 'other', true);
  });

  it('only talks on Telegram when asked to', async () => {
    const { deps, enqueue, record } = fakeDeps([ROWS[0]]);
    await requeueEmptyAnalysis(deps, parseArgs(['--notify']));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ notify: true }));
    expect(record).toHaveBeenCalledWith('e1', 'instagram', false);
  });

  it('with nothing to do it queues nothing and does not even look for a chat', async () => {
    const { deps, enqueue, db } = fakeDeps([]);
    const out = await requeueEmptyAnalysis(deps, parseArgs([]));
    expect(out).toEqual({ found: 0, queued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('GROUP BY chat_id'))).toBe(false);
  });

  it('stops at the first failure to queue instead of carrying on half-blind', async () => {
    const { deps, record } = fakeDeps(ROWS, { enqueue: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(requeueEmptyAnalysis(deps, parseArgs([]))).rejects.toThrow('db down');
    expect(record).not.toHaveBeenCalled();
  });
});
