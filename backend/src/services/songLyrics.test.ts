import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }));

import { internetLyrics, isRealTranscript, lyricsFor, lyricsOnlineEnabled, MIN_TRANSCRIPT_CHARS, NOT_FOUND_TTL_MS, originalOf, realLyricsDeps, type LyricsRow, type SongForLyrics, type SongLyricsDeps } from './songLyrics';
import { query } from '../utils/db';
import type { OnlineLyrics, Wanted } from './lyricsFinder';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const song = (over: Partial<SongForLyrics> = {}): SongForLyrics => ({ songKey: 'artist::song', artist: 'Artist', title: 'Song', album: null, versionOf: null, ...over });

/** The table in memory, and the archive as a script. */
function world(initial: Record<string, LyricsRow> = {}, online: (w: Wanted) => Promise<OnlineLyrics> = async () => ({ answered: true, kind: 'none' })) {
  const table = new Map<string, LyricsRow>(Object.entries(initial));
  const writes: Array<{ songKey: string; lyrics: string | null; instrumental: boolean; sourceId: string | null }> = [];
  const asked: Wanted[] = [];
  const deps: SongLyricsDeps = {
    read: async (key) => table.get(key) ?? null,
    write: async (key, row) => {
      writes.push({ songKey: key, ...row });
      table.set(key, { lyrics: row.lyrics, instrumental: row.instrumental, checkedAt: new Date(NOW) });
    },
    online: vi.fn(async (w: Wanted) => {
      asked.push(w);
      return online(w);
    }),
    now: () => NOW,
    enabled: () => true,
  };
  return { deps, table, writes, asked };
}

/** A transcript that is long enough to be the words (100 characters or more) and one that is only a fragment of what Whisper caught. */
const REAL_TRANSCRIPT = 'what the video says, the verse and the chorus go on and on, '.repeat(3);
const FRAGMENT = 'what the video says';

const lyrics = (text: string, sourceId: string | null = '7'): OnlineLyrics => ({ answered: true, kind: 'lyrics', text, sourceId });
const none: OnlineLyrics = { answered: true, kind: 'none' };
const outage: OnlineLyrics = { answered: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('what the server answers for a song', () => {
  it('is the transcript of the post when it is a real one, and the Internet is not even asked', async () => {
    const w = world({}, async () => lyrics('the real words'));
    expect(await lyricsFor(song(), REAL_TRANSCRIPT, w.deps)).toEqual({ text: REAL_TRANSCRIPT, source: 'transcript', instrumental: false });
    expect(w.deps.online).not.toHaveBeenCalled();
  });

  it('is what the Internet has when the transcript is missing or blank', async () => {
    const w = world({}, async () => lyrics('the real words'));
    for (const transcript of [null, '', '   \n ']) {
      expect(await lyricsFor(song({ songKey: `k::${String(transcript).length}` }), transcript, w.deps)).toEqual({ text: 'the real words', source: 'internet', instrumental: false });
    }
  });

  it('is nothing when neither has anything', async () => {
    expect(await lyricsFor(song(), null, world().deps)).toBeNull();
  });
});

// Michele, 8 November, on the proposal that a very short transcript is not the words of the song: «Proposta accettata» (spec L12).
describe('a fragment of transcript counts as «text missing» (spec L12)', () => {
  it('the line is 100 characters: 99 is a fragment, 100 is a transcript', async () => {
    expect(MIN_TRANSCRIPT_CHARS).toBe(100);
    expect(isRealTranscript('x'.repeat(99))).toBe(false);
    expect(isRealTranscript('x'.repeat(100))).toBe(true);
    const w = world({}, async () => lyrics('the real words'));
    expect(await lyricsFor(song({ songKey: 'a::99' }), 'x'.repeat(99), w.deps)).toMatchObject({ source: 'internet' });
    expect(await lyricsFor(song({ songKey: 'a::100' }), 'x'.repeat(100), w.deps)).toMatchObject({ source: 'transcript' });
  });

  it('spaces around the words do not make a fragment longer', () => {
    expect(isRealTranscript(`   ${'x'.repeat(90)}   \n\n  `)).toBe(false);
    expect(isRealTranscript(null)).toBe(false);
    expect(isRealTranscript('')).toBe(false);
  });

  it('the Internet is asked, and its words win over the fragment', async () => {
    const w = world({}, async () => lyrics('the real words'));
    expect(await lyricsFor(song(), FRAGMENT, w.deps)).toEqual({ text: 'the real words', source: 'internet', instrumental: false });
    expect(w.asked).toHaveLength(1);
  });

  it('nothing on the Internet: the fragment stays, and «not found» is remembered (asked once)', async () => {
    const w = world({}, async () => none);
    expect(await lyricsFor(song(), FRAGMENT, w.deps)).toEqual({ text: FRAGMENT, source: 'transcript', instrumental: false });
    expect(await lyricsFor(song(), FRAGMENT, w.deps)).toEqual({ text: FRAGMENT, source: 'transcript', instrumental: false });
    expect(w.asked).toHaveLength(1);
    expect(w.writes).toEqual([{ songKey: 'artist::song', lyrics: null, instrumental: false, sourceId: null }]);
  });

  it('the search is switched off: the fragment is served and the archive is never asked', async () => {
    const w = world({}, async () => lyrics('the real words'));
    const off: SongLyricsDeps = { ...w.deps, enabled: () => false };
    expect(await lyricsFor(song(), FRAGMENT, off)).toEqual({ text: FRAGMENT, source: 'transcript', instrumental: false });
    expect(w.asked).toHaveLength(0);
  });

  it('an outage of the archive: the fragment is served and nothing is remembered', async () => {
    const w = world({}, async () => outage);
    expect(await lyricsFor(song(), FRAGMENT, w.deps)).toEqual({ text: FRAGMENT, source: 'transcript', instrumental: false });
    expect(w.writes).toEqual([]);
  });

  it('an instrumental found on the Internet wins over the fragment (the fragment is only for «nothing found»)', async () => {
    const w = world({}, async () => ({ answered: true, kind: 'instrumental', sourceId: '9' }));
    expect(await lyricsFor(song(), FRAGMENT, w.deps)).toEqual({ text: '', source: 'internet', instrumental: true });
  });

  it('a real transcript is never replaced, even when the Internet has a text', async () => {
    const w = world({}, async () => lyrics('the real words'));
    expect(await lyricsFor(song(), REAL_TRANSCRIPT, w.deps)).toMatchObject({ source: 'transcript', text: REAL_TRANSCRIPT });
    expect(w.asked).toHaveLength(0);
  });

  it('a blank transcript is no fragment: nothing to fall back to', async () => {
    const w = world({}, async () => none);
    expect(await lyricsFor(song(), '   ', w.deps)).toBeNull();
  });
});

describe('a text found stays; «not found» is remembered for a week; an outage is not remembered', () => {
  it('keeps the words it found, and asks the archive once', async () => {
    const w = world({}, async () => lyrics('the real words', '42'));
    expect(await internetLyrics(song(), w.deps)).toEqual({ text: 'the real words', instrumental: false });
    expect(w.writes).toEqual([{ songKey: 'artist::song', lyrics: 'the real words', instrumental: false, sourceId: '42' }]);
    expect(await internetLyrics(song(), w.deps)).toEqual({ text: 'the real words', instrumental: false });
    expect(w.asked).toHaveLength(1);
  });

  it('a text found is never asked again, however old', async () => {
    const w = world({ 'artist::song': { lyrics: 'kept words', instrumental: false, checkedAt: new Date(NOW - 400 * DAY) } });
    expect(await internetLyrics(song(), w.deps)).toEqual({ text: 'kept words', instrumental: false });
    expect(w.asked).toHaveLength(0);
  });

  it('remembers «not there» and does not ask again for a week', async () => {
    const w = world();
    expect(await internetLyrics(song(), w.deps)).toBeNull();
    expect(w.writes).toEqual([{ songKey: 'artist::song', lyrics: null, instrumental: false, sourceId: null }]);
    expect(await internetLyrics(song(), w.deps)).toBeNull();
    expect(w.asked).toHaveLength(1);
  });

  it('asks again after the week', async () => {
    const stale = world({ 'artist::song': { lyrics: null, instrumental: false, checkedAt: new Date(NOW - NOT_FOUND_TTL_MS - 1000) } }, async () => lyrics('now it is there'));
    expect(await internetLyrics(song(), stale.deps)).toEqual({ text: 'now it is there', instrumental: false });
    const fresh = world({ 'artist::song': { lyrics: null, instrumental: false, checkedAt: new Date(NOW - NOT_FOUND_TTL_MS + 60_000) } }, async () => lyrics('x'));
    expect(await internetLyrics(song(), fresh.deps)).toBeNull();
    expect(fresh.asked).toHaveLength(0);
  });

  it('an outage writes nothing: it is not an answer, the next play asks again', async () => {
    const w = world({}, async () => outage);
    expect(await internetLyrics(song(), w.deps)).toBeNull();
    expect(w.writes).toEqual([]);
    expect(w.table.size).toBe(0);
  });

  it('a failing table does not break the answer: nobody sees an error, the song just has no words', async () => {
    const w = world();
    w.deps.read = async () => { throw new Error('db down'); };
    await expect(internetLyrics(song(), w.deps)).resolves.toBeNull();
  });
});

describe('instrumentals', () => {
  it('are kept as instrumentals and answer with no text', async () => {
    const w = world({}, async () => ({ answered: true, kind: 'instrumental', sourceId: '9' }));
    expect(await internetLyrics(song(), w.deps)).toEqual({ text: '', instrumental: true });
    expect(w.writes).toEqual([{ songKey: 'artist::song', lyrics: null, instrumental: true, sourceId: '9' }]);
    expect(await lyricsFor(song(), null, w.deps)).toEqual({ text: '', source: 'internet', instrumental: true });
    expect(w.asked).toHaveLength(1);
  });
});

describe('versions: no words of its own, the original\'s', () => {
  const sped = (labels: string[] = ['Speed']): SongForLyrics => song({ songKey: 'artist::song (speed)', title: 'Song (Speed)', versionOf: { title: 'Song', artist: null, labels } });

  it('asks for the song itself first, then for its original, and keeps the words under the VERSION\'s key', async () => {
    const w = world({}, async (wanted) => (wanted.title === 'Song' ? lyrics('original words') : none));
    expect(await internetLyrics(sped(), w.deps)).toEqual({ text: 'original words', instrumental: false });
    expect(w.asked.map((a) => a.title)).toEqual(['Song (Speed)', 'Song']);
    expect(w.asked[1].artist).toBe('Artist');
    expect(w.writes[0].songKey).toBe('artist::song (speed)');
  });

  it('does not ask for the original when the song itself has words', async () => {
    const w = world({}, async () => lyrics('its own words'));
    await internetLyrics(sped(), w.deps);
    expect(w.asked).toHaveLength(1);
  });

  it('never borrows the words of an original for an Instrumental or a Karaoke', async () => {
    expect(originalOf(sped(['Instrumental']))).toBeNull();
    expect(originalOf(sped(['Karaoke Version']))).toBeNull();
    const w = world({}, async () => none);
    await internetLyrics(sped(['Instrumental']), w.deps);
    expect(w.asked).toHaveLength(1);
  });

  it('an instrumental original says nothing about the version', async () => {
    const w = world({}, async (wanted) => (wanted.title === 'Song' ? { answered: true, kind: 'instrumental', sourceId: '1' } : none));
    expect(await internetLyrics(sped(), w.deps)).toBeNull();
    expect(w.table.get('artist::song (speed)')?.instrumental).toBe(false);
  });

  it('uses the original\'s artist when the song says one', () => {
    expect(originalOf(song({ versionOf: { title: 'Song', artist: 'Real Artist', labels: ['Remix'] } }))).toEqual({ artist: 'Real Artist', title: 'Song', album: null });
  });

  it('an outage on the first try is not turned into «not there» by an empty second', async () => {
    const w = world({}, async (wanted) => (wanted.title === 'Song (Speed)' ? outage : none));
    expect(await internetLyrics(sped(), w.deps)).toBeNull();
    expect(w.writes).toEqual([]);
  });
});

describe('the switch and the single line', () => {
  it('with the Internet switched off, the Internet is not asked and nothing is remembered; a kept text still comes', async () => {
    const off = world({}, async () => lyrics('x'));
    off.deps.enabled = () => false;
    expect(await internetLyrics(song(), off.deps)).toBeNull();
    expect(off.asked).toHaveLength(0);
    expect(off.writes).toEqual([]);

    const kept = world({ 'artist::song': { lyrics: 'kept words', instrumental: false, checkedAt: new Date(NOW) } });
    kept.deps.enabled = () => false;
    expect(await internetLyrics(song(), kept.deps)).toEqual({ text: 'kept words', instrumental: false });
  });

  it('the switch is LYRICS_ONLINE: on by default, off for 0, false, off, no', () => {
    const old = process.env.LYRICS_ONLINE;
    try {
      delete process.env.LYRICS_ONLINE;
      expect(lyricsOnlineEnabled()).toBe(true);
      for (const v of ['0', 'false', 'OFF', 'no', ' 0 ']) {
        process.env.LYRICS_ONLINE = v;
        expect(lyricsOnlineEnabled()).toBe(false);
      }
      process.env.LYRICS_ONLINE = '1';
      expect(lyricsOnlineEnabled()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.LYRICS_ONLINE; else process.env.LYRICS_ONLINE = old;
    }
  });

  it('two requests for the same song at the same moment share ONE search', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const w = world({}, async () => { await gate; return lyrics('shared'); });
    const first = internetLyrics(song(), w.deps);
    const second = internetLyrics(song(), w.deps);
    release();
    expect(await Promise.all([first, second])).toEqual([{ text: 'shared', instrumental: false }, { text: 'shared', instrumental: false }]);
    expect(w.asked).toHaveLength(1);
  });

  it('other songs do not wait for each other\'s search', async () => {
    const w = world({}, async (wanted) => lyrics(`words of ${wanted.title}`));
    const [a, b] = await Promise.all([internetLyrics(song({ songKey: 'a::a', title: 'A' }), w.deps), internetLyrics(song({ songKey: 'b::b', title: 'B' }), w.deps)]);
    expect([a?.text, b?.text]).toEqual(['words of A', 'words of B']);
  });
});

describe('the table', () => {
  it('reads one row by key and writes it with an upsert (no duplicate key, the date moves)', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ lyrics: 'kept', instrumental: false, checked_at: new Date(NOW) }] as never);
    expect(await realLyricsDeps.read('artist::song')).toEqual({ lyrics: 'kept', instrumental: false, checkedAt: new Date(NOW) });
    expect(String(vi.mocked(query).mock.calls[0][0])).toContain('WHERE song_key = $1');
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['artist::song']);

    vi.mocked(query).mockResolvedValueOnce([] as never);
    await expect(realLyricsDeps.read('nobody::nothing')).resolves.toBeNull();

    vi.mocked(query).mockResolvedValueOnce([] as never);
    await realLyricsDeps.write('artist::song', { lyrics: 'words', instrumental: false, sourceId: '5' });
    const [sql, params] = vi.mocked(query).mock.calls[2];
    expect(String(sql)).toContain('ON CONFLICT (song_key) DO UPDATE');
    expect(String(sql)).toContain('checked_at = now()');
    expect(params).toEqual(['artist::song', 'words', false, '5']);
  });
});
