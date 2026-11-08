import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));

import {
  claimNextDownloads,
  enqueueSongDownload,
  fromRow,
  getSongFiles,
  markAttemptFailed,
  PRIORITY_PLAY,
} from './songFiles';

const row = (over: Record<string, unknown> = {}) => ({
  song_key: 'a::b', status: 'queued', source: null, rel_path: null, bytes: null, mtime_ms: null, duration_s: null,
  match: null, video_id: null, video_url_override: null, media_url: null, published_at: null, error: null, attempts: 0,
  priority: 0, next_attempt_at: new Date('2026-11-07T20:00:00Z'), locked_at: null, requested_by: null, artist: 'a',
  title: 'b', album: null, cover_url: null, expected_duration_s: null, updated_at: new Date('2026-11-07T20:00:00Z'), ...over,
});

beforeEach(() => queryMock.mockReset());

describe('songFiles (SQL semantics are proven against a real Postgres; these guard the mapping and parameters)', () => {
  it('maps bigint strings from pg to numbers and dates to Date', () => {
    const f = fromRow(row({ bytes: '6291456', mtime_ms: '1794085004000', published_at: '2026-11-07T20:00:00Z' }) as never);
    expect(f.bytes).toBe(6291456);
    expect(f.mtimeMs).toBe(1794085004000);
    expect(f.publishedAt).toBeInstanceOf(Date);
    expect(f.lockedAt).toBeNull();
  });

  it('enqueue passes priority, snapshot metadata and the retry flag in the documented order', async () => {
    queryMock.mockResolvedValue([row()]);
    await enqueueSongDownload({
      songKey: 'bishop briggs::white flag', artist: 'Bishop Briggs', title: 'White Flag', album: 'Church of Scars',
      coverUrl: 'c', expectedDurationS: 230, requestedBy: 'mike', priority: PRIORITY_PLAY, retry: true,
    });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(song_key\) DO UPDATE/);
    expect(params).toEqual([
      'bishop briggs::white flag', PRIORITY_PLAY, 'mike', 'Bishop Briggs', 'White Flag', 'Church of Scars', 'c', 230, true,
    ]);
  });

  it('enqueue defaults to sync priority, no retry, nulls for the optional metadata', async () => {
    queryMock.mockResolvedValue([row()]);
    await enqueueSongDownload({ songKey: 'a::b', artist: 'a', title: 'b' });
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual(['a::b', 0, null, 'a', 'b', null, null, null, false]);
  });

  it('claim hands jobs back highest priority first (UPDATE … RETURNING has no order of its own)', async () => {
    queryMock.mockResolvedValue([
      row({ song_key: 'sync-old', priority: 0, next_attempt_at: new Date('2026-11-07T19:00:00Z') }),
      row({ song_key: 'play', priority: 10, next_attempt_at: new Date('2026-11-07T20:00:00Z') }),
      row({ song_key: 'sync-new', priority: 0, next_attempt_at: new Date('2026-11-07T19:30:00Z') }),
    ]);
    const jobs = await claimNextDownloads(3);
    expect(jobs.map((j) => j.songKey)).toEqual(['play', 'sync-old', 'sync-new']);
    expect((queryMock.mock.calls[0] as [string, unknown[]])[0]).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('terminal failure ends the job, transient failure backs off', async () => {
    queryMock.mockResolvedValue([]);
    await markAttemptFailed('a::b', { error: 'nessuna sorgente', terminal: 'no_source' });
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual(['a::b', 'no_source', 'nessuna sorgente']);
    await markAttemptFailed('a::b', { error: 'HTTP 403', retryInMs: 120_000 });
    expect((queryMock.mock.calls[1] as [string, unknown[]])[1]).toEqual(['a::b', 'HTTP 403', 120_000]);
    await markAttemptFailed('a::b', { error: 'x' });
    expect((queryMock.mock.calls[2] as [string, unknown[]])[1]).toEqual(['a::b', 'x', 60_000]);
  });

  it('getSongFiles does not hit the database for an empty list', async () => {
    expect((await getSongFiles([])).size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
