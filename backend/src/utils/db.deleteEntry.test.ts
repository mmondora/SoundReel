import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgQuery = vi.hoisted(() => vi.fn());

vi.mock('pg', () => ({
  Pool: function Pool() {
    return { query: pgQuery, on: vi.fn(), connect: vi.fn() };
  },
}));

import { deleteAllEntries, deleteEntry } from './db';

describe('deleting entries that went through the job queue', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQuery.mockResolvedValue({ rows: [], rowCount: 3 });
  });

  it('deleteEntry removes the queue rows in the same statement (job_queue FK has no cascade)', async () => {
    await deleteEntry('entry-1');
    expect(pgQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM job_queue WHERE entry_id = \$1/);
    expect(sql).toMatch(/DELETE FROM entries WHERE id = \$1/);
    expect(sql.indexOf('job_queue')).toBeLessThan(sql.indexOf('FROM entries'));
    expect(params).toEqual(['entry-1']);
  });

  it('deleteAllEntries empties the queue too and reports the number of entries', async () => {
    await expect(deleteAllEntries()).resolves.toBe(3);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/DELETE FROM job_queue/);
    expect(sql).toMatch(/DELETE FROM entries/);
  });
});
