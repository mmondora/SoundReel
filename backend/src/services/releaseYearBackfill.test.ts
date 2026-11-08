import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));
vi.mock('./songMeta', () => ({
  listReleaseYearChecked: vi.fn(),
  setReleaseYear: vi.fn(),
  upsertSongEnrichment: vi.fn(),
}));
vi.mock('./songEnrichment', () => ({ enrichSongWithYear: vi.fn(), lookupItunesYear: vi.fn() }));

import {
  realBackfillDeps,
  releaseYearBackfillEnabled,
  runReleaseYearBackfill,
  startReleaseYearBackfill,
  type BackfillDeps,
  type BackfillSong,
  type SettledOutcome,
  type YearOutcome,
} from './releaseYearBackfill';
import { enrichSongWithYear, lookupItunesYear, type SongEnrichmentResult } from './songEnrichment';
import { setReleaseYear, upsertSongEnrichment } from './songMeta';

const song = (n: number, enriched = true): BackfillSong => ({ key: `artist${n}::title${n}`, artist: `Artist ${n}`, title: `Title ${n}`, enriched });

const YEAR = (year: number): YearOutcome => ({ kind: 'year', year });
const NONE: YearOutcome = { kind: 'none' };
const FAILED: YearOutcome = { kind: 'failed' };

/** `outcomes[i]` is what asking about the i-th song comes to; an Error is a lookup that throws. */
function fakeDeps(songs: BackfillSong[], outcomes: Array<YearOutcome | Error>, checked: string[] = []) {
  let asked = 0;
  const calls = {
    looked: [] as BackfillSong[],
    recorded: [] as Array<{ key: string; outcome: SettledOutcome }>,
    sleeps: [] as number[],
  };
  const deps: BackfillDeps = {
    listSongs: async () => songs,
    listChecked: async () => new Set(checked),
    lookup: async (s) => {
      calls.looked.push(s);
      const o = outcomes[asked++];
      if (o instanceof Error) throw o;
      return o ?? NONE;
    },
    record: async (s, outcome) => void calls.recorded.push({ key: s.key, outcome }),
    sleep: async (ms) => void calls.sleeps.push(ms),
  };
  return { deps, calls };
}

describe('runReleaseYearBackfill', () => {
  it('asks only about songs not asked about yet, in library order, and records each answer', async () => {
    const songs = [song(1), song(2), song(3), song(4)];
    const { deps, calls } = fakeDeps(songs, [YEAR(1980), YEAR(1990)], [songs[0].key, songs[2].key]);
    const report = await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.looked.map((s) => s.title)).toEqual(['Title 2', 'Title 4']);
    expect(calls.recorded.map((r) => [r.key, r.outcome.kind])).toEqual([[songs[1].key, 'year'], [songs[3].key, 'year']]);
    expect(report).toMatchObject({ total: 4, todo: 2, checked: 2, withYear: 2, noYear: 0, aborted: false, remaining: 0 });
  });

  it('does nothing when every song was asked about already (the pass is one-off)', async () => {
    const songs = [song(1), song(2)];
    const { deps, calls } = fakeDeps(songs, [], songs.map((s) => s.key));
    const report = await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.looked).toEqual([]);
    expect(calls.sleeps).toEqual([]);
    expect(report).toMatchObject({ todo: 0, checked: 0, remaining: 0, aborted: false });
  });

  it('hands the lookup the whole song, so it knows whether the song is already enriched', async () => {
    const { deps, calls } = fakeDeps([song(1, true), song(2, false)], [YEAR(1980), YEAR(1981)]);
    await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.looked.map((s) => s.enriched)).toEqual([true, false]);
  });

  it('"iTunes answered, no date it can vouch for" is final: recorded as checked, never asked again', async () => {
    const { deps, calls } = fakeDeps([song(1)], [NONE]);
    const report = await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.recorded).toEqual([{ key: song(1).key, outcome: NONE }]);
    expect(report).toMatchObject({ checked: 1, withYear: 0, noYear: 1, remaining: 0 });
  });

  it('passes the enrichment of a song that had none on to be recorded with its year', async () => {
    const enrichment = { deezerId: null, itunesId: 7, genres: ['Pop'], album: 'A', releaseYear: 1984, coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null } as SongEnrichmentResult;
    const { deps, calls } = fakeDeps([song(1, false)], [{ kind: 'year', year: 1984, enrichment }]);
    await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.recorded[0].outcome).toEqual({ kind: 'year', year: 1984, enrichment });
  });

  it('a failed question is NOT recorded: that song is asked again next time', async () => {
    const songs = [song(1), song(2), song(3)];
    const { deps, calls } = fakeDeps(songs, [YEAR(1980), FAILED, YEAR(1990)]);
    const report = await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.recorded.map((r) => r.key)).toEqual([songs[0].key, songs[2].key]);
    expect(report).toMatchObject({ checked: 2, remaining: 1, aborted: false });
  });

  it('a success resets the count of failures: scattered failures never stop the pass', async () => {
    const songs = Array.from({ length: 9 }, (_, i) => song(i + 1));
    const { deps, calls } = fakeDeps(songs, [FAILED, FAILED, YEAR(1980), FAILED, FAILED, YEAR(1985), FAILED, FAILED, YEAR(1990)]);
    const report = await runReleaseYearBackfill(deps, { delayMs: 0, maxConsecutiveFailures: 3 });
    expect(report.aborted).toBe(false);
    expect(calls.looked).toHaveLength(9);
    expect(report).toMatchObject({ checked: 3, withYear: 3, remaining: 6 });
  });

  it('stops when too many questions in a row fail (an outage), keeping what was settled before and recording nothing for the failures', async () => {
    const songs = Array.from({ length: 10 }, (_, i) => song(i + 1));
    const { deps, calls } = fakeDeps(songs, [YEAR(1980), YEAR(1985), FAILED, FAILED, FAILED]);
    const report = await runReleaseYearBackfill(deps, { delayMs: 0, maxConsecutiveFailures: 3 });
    expect(report.aborted).toBe(true);
    expect(calls.looked).toHaveLength(5); // two answers, then three failures, then it gives up
    expect(calls.recorded.map((r) => r.key)).toEqual([songs[0].key, songs[1].key]);
    expect(report).toMatchObject({ checked: 2, withYear: 2, remaining: 8 });
  });

  it('an "iTunes does not know it" answer is not a failure: any number of them in a row go on', async () => {
    const songs = Array.from({ length: 8 }, (_, i) => song(i + 1));
    const { deps, calls } = fakeDeps(songs, Array(8).fill(NONE));
    const report = await runReleaseYearBackfill(deps, { delayMs: 0, maxConsecutiveFailures: 3 });
    expect(report).toMatchObject({ aborted: false, checked: 8, noYear: 8, remaining: 0 });
    expect(calls.recorded).toHaveLength(8);
  });

  it('counts a lookup that throws as a failure and carries on', async () => {
    const songs = [song(1), song(2)];
    const { deps, calls } = fakeDeps(songs, [new Error('socket hang up'), YEAR(1992)]);
    const report = await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.recorded.map((r) => r.key)).toEqual([songs[1].key]);
    expect(report).toMatchObject({ checked: 1, withYear: 1, remaining: 1, aborted: false });
  });

  it('waits between songs', async () => {
    const { deps, calls } = fakeDeps([song(1), song(2), song(3)], [YEAR(1), YEAR(2), YEAR(3)].map(() => YEAR(1990)));
    await runReleaseYearBackfill(deps);
    expect(calls.sleeps).toEqual([600, 600, 600]);
  });

  it('stops early when asked to (the server is shutting down)', async () => {
    const songs = [song(1), song(2), song(3)];
    const { deps, calls } = fakeDeps(songs, [YEAR(1980), YEAR(1981), YEAR(1982)]);
    let n = 0;
    deps.shouldStop = () => n++ >= 1; // fine for the first song, stop before the second
    const report = await runReleaseYearBackfill(deps, { delayMs: 0 });
    expect(calls.looked).toHaveLength(1);
    expect(report).toMatchObject({ aborted: true, checked: 1, remaining: 2 });
  });
});

describe('the real dependencies (what is asked, and what is written)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an enriched song gets the YEAR-ONLY lookup, never the full enrichment, and only the year is written', async () => {
    vi.mocked(lookupItunesYear).mockResolvedValue({ answered: true, year: 1975 });
    const deps = realBackfillDeps();
    const s = song(1, true);
    const outcome = await deps.lookup(s);
    expect(outcome).toEqual({ kind: 'year', year: 1975 });
    expect(lookupItunesYear).toHaveBeenCalledWith('Artist 1', 'Title 1');
    expect(enrichSongWithYear).not.toHaveBeenCalled();
    await deps.record(s, outcome as SettledOutcome);
    expect(setReleaseYear).toHaveBeenCalledWith(s.key, 1975);
    expect(upsertSongEnrichment).not.toHaveBeenCalled(); // cover, genres and links stay as they were
  });

  it('an enriched song iTunes does not vouch for is a final "no year": the check is recorded, nothing else', async () => {
    vi.mocked(lookupItunesYear).mockResolvedValue({ answered: true, year: null });
    const deps = realBackfillDeps();
    const s = song(1, true);
    const outcome = await deps.lookup(s);
    expect(outcome).toEqual({ kind: 'none' });
    await deps.record(s, outcome as SettledOutcome);
    expect(setReleaseYear).toHaveBeenCalledWith(s.key, null);
    expect(upsertSongEnrichment).not.toHaveBeenCalled();
  });

  it('an iTunes that could not be asked is a FAILURE, not "no year"', async () => {
    vi.mocked(lookupItunesYear).mockResolvedValue({ answered: false, year: null });
    expect(await realBackfillDeps().lookup(song(1, true))).toEqual({ kind: 'failed' });
  });

  it('a song never enriched gets the normal enrichment, and it is written whole with its year', async () => {
    const enrichment = { deezerId: null, itunesId: 7, genres: ['Pop'], album: 'A', releaseYear: 1984, coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null } as SongEnrichmentResult;
    vi.mocked(enrichSongWithYear).mockResolvedValue(enrichment);
    const deps = realBackfillDeps();
    const s = song(2, false);
    const outcome = await deps.lookup(s);
    expect(outcome).toEqual({ kind: 'year', year: 1984, enrichment });
    expect(lookupItunesYear).not.toHaveBeenCalled();
    await deps.record(s, outcome as SettledOutcome);
    expect(upsertSongEnrichment).toHaveBeenCalledWith({ songKey: s.key, ...enrichment });
    expect(setReleaseYear).not.toHaveBeenCalled();
  });

  it('a never-enriched song with an enrichment but no year keeps the enrichment and is marked as checked', async () => {
    const enrichment = { deezerId: null, itunesId: 7, genres: [], album: null, releaseYear: null, coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null } as SongEnrichmentResult;
    vi.mocked(enrichSongWithYear).mockResolvedValue(enrichment);
    const deps = realBackfillDeps();
    const outcome = await deps.lookup(song(2, false));
    expect(outcome).toEqual({ kind: 'none', enrichment });
  });

  it('a never-enriched song nobody knows is a plain "no year" (the row is created only to remember the check)', async () => {
    vi.mocked(enrichSongWithYear).mockResolvedValue(null);
    const deps = realBackfillDeps();
    const s = song(3, false);
    const outcome = await deps.lookup(s);
    expect(outcome).toEqual({ kind: 'none' });
    await deps.record(s, outcome as SettledOutcome);
    expect(setReleaseYear).toHaveBeenCalledWith(s.key, null);
    expect(upsertSongEnrichment).not.toHaveBeenCalled();
  });
});

describe('releaseYearBackfillEnabled', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on by default', () => {
    vi.stubEnv('SONG_ENRICHMENT_ENABLED', '');
    vi.stubEnv('RELEASE_YEAR_BACKFILL_ENABLED', '');
    expect(releaseYearBackfillEnabled()).toBe(true);
  });

  it('follows the enrichment switch (tests set it to 0, so no suite reaches iTunes)', () => {
    vi.stubEnv('SONG_ENRICHMENT_ENABLED', '0');
    expect(releaseYearBackfillEnabled()).toBe(false);
  });

  it('has its own switch', () => {
    vi.stubEnv('SONG_ENRICHMENT_ENABLED', '1');
    vi.stubEnv('RELEASE_YEAR_BACKFILL_ENABLED', 'off');
    expect(releaseYearBackfillEnabled()).toBe(false);
  });
});

describe('startReleaseYearBackfill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('SONG_ENRICHMENT_ENABLED', '1');
    vi.stubEnv('RELEASE_YEAR_BACKFILL_ENABLED', '1');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('runs once after the boot delay, not before', async () => {
    const { deps, calls } = fakeDeps([song(1)], [YEAR(1980)]);
    const stop = startReleaseYearBackfill({ deps, firstRunDelayMs: 5_000, runOptions: { delayMs: 0 } });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls.looked).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls.looked.map((s) => s.title)).toEqual(['Title 1']);
    stop();
  });

  it('does not run at all when switched off', async () => {
    vi.stubEnv('SONG_ENRICHMENT_ENABLED', '0');
    const { deps, calls } = fakeDeps([song(1)], [YEAR(1980)]);
    const stop = startReleaseYearBackfill({ deps, firstRunDelayMs: 10, runOptions: { delayMs: 0 } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.looked).toEqual([]);
    stop();
  });

  it('stop() cancels a run that has not started', async () => {
    const { deps, calls } = fakeDeps([song(1)], [YEAR(1980)]);
    const stop = startReleaseYearBackfill({ deps, firstRunDelayMs: 5_000, runOptions: { delayMs: 0 } });
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.looked).toEqual([]);
  });

  it('tries again later after an outage, and finishes the job when iTunes is back', async () => {
    const songs = [song(1), song(2), song(3)];
    // first pass: three failures in a row -> aborted; second pass: all answered
    const { deps, calls } = fakeDeps(songs, [FAILED, FAILED, FAILED, YEAR(1980), YEAR(1981), YEAR(1982)]);
    const stop = startReleaseYearBackfill({ deps, firstRunDelayMs: 1_000, retryMs: 10_000, runOptions: { delayMs: 0, maxConsecutiveFailures: 3 } });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(calls.looked).toHaveLength(3);
    expect(calls.recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(calls.looked).toHaveLength(6);
    expect(calls.recorded.map((r) => r.key)).toEqual(songs.map((s) => s.key));
    stop();
  });

  it('does not schedule another pass when the job finished', async () => {
    const { deps, calls } = fakeDeps([song(1)], [YEAR(1980), YEAR(1981)]);
    const stop = startReleaseYearBackfill({ deps, firstRunDelayMs: 100, retryMs: 1_000, runOptions: { delayMs: 0 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.looked).toHaveLength(1);
    stop();
  });

  it('survives a database error and retries later', async () => {
    let first = true;
    const { deps, calls } = fakeDeps([song(1)], [YEAR(1980)]);
    const realList = deps.listSongs;
    deps.listSongs = async () => {
      if (first) {
        first = false;
        throw new Error('db down');
      }
      return realList();
    };
    const stop = startReleaseYearBackfill({ deps, firstRunDelayMs: 100, retryMs: 5_000, runOptions: { delayMs: 0 } });
    await vi.advanceTimersByTimeAsync(101);
    expect(calls.looked).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(calls.looked.map((s) => s.title)).toEqual(['Title 1']);
    stop();
  });
});
