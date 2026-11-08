/**
 * The lyrics of a song as the SERVER has them (ADR-0021, spec 2026-11-08-lyrics-from-the-internet-design.md): the transcript of the
 * post when there is one, else what was found on the Internet and kept. The app asks `GET /api/mondrop/songs/:key/lyrics` and nothing
 * else (rule P).
 *
 * The Internet is asked only when the text is MISSING («quando mancano»): a transcript is never replaced. A text found stays; «not
 * found» is remembered for 7 days; an outage of the archive is not an answer and is not remembered. A song that is a VERSION of
 * another (Speed, Slowed + Reverb, Remix…) with no text of its own falls back to its original, except an Instrumental or a Karaoke.
 * Two requests for the same song share one search. `LYRICS_ONLINE=0` switches the Internet off (transcripts are still served).
 */
import { query } from '../utils/db';
import { logInfo, logWarning } from '../utils/logger';
import { findLyricsOnline, type OnlineLyrics, type Wanted } from './lyricsFinder';

export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LyricsRow {
  lyrics: string | null;
  instrumental: boolean;
  checkedAt: Date;
}

export interface SongLyricsDeps {
  read: (songKey: string) => Promise<LyricsRow | null>;
  write: (songKey: string, row: { lyrics: string | null; instrumental: boolean; sourceId: string | null }) => Promise<void>;
  online: (wanted: Wanted) => Promise<OnlineLyrics>;
  now: () => number;
  enabled: () => boolean;
}

export interface SongForLyrics {
  songKey: string;
  artist: string;
  title: string;
  album?: string | null;
  /** The song this one is a version of (ADR-0017), with the markers that say how. */
  versionOf?: { title: string; artist: string | null; labels: string[] } | null;
}

export interface LyricsAnswer {
  text: string;
  source: 'transcript' | 'internet';
  instrumental: boolean;
}

export const lyricsOnlineEnabled = (): boolean => !/^(0|false|off|no)$/i.test((process.env.LYRICS_ONLINE ?? '').trim());

export const realLyricsDeps: SongLyricsDeps = {
  async read(songKey) {
    const rows = await query<{ lyrics: string | null; instrumental: boolean; checked_at: Date }>(
      'SELECT lyrics, instrumental, checked_at FROM song_lyrics WHERE song_key = $1',
      [songKey],
    );
    const row = rows[0];
    return row ? { lyrics: row.lyrics, instrumental: row.instrumental, checkedAt: new Date(row.checked_at) } : null;
  },
  async write(songKey, row) {
    await query(
      `INSERT INTO song_lyrics (song_key, lyrics, instrumental, source, source_id, checked_at)
       VALUES ($1, $2, $3, 'lrclib', $4, now())
       ON CONFLICT (song_key) DO UPDATE
         SET lyrics = EXCLUDED.lyrics, instrumental = EXCLUDED.instrumental, source_id = EXCLUDED.source_id, checked_at = now()`,
      [songKey, row.lyrics, row.instrumental, row.sourceId],
    );
  },
  online: (wanted) => findLyricsOnline(wanted),
  now: () => Date.now(),
  enabled: lyricsOnlineEnabled,
};

/** The original of a version, or null: an Instrumental or a Karaoke has no words, so it has no original's words either. */
export function originalOf(song: SongForLyrics): Wanted | null {
  const version = song.versionOf;
  if (!version || !version.title.trim()) return null;
  if (version.labels.some((label) => /instrumental|karaoke/i.test(label))) return null;
  return { artist: version.artist?.trim() || song.artist, title: version.title, album: null };
}

type Found = { text: string; instrumental: boolean };

const inFlight = new Map<string, Promise<Found | null>>();

async function find(song: SongForLyrics, deps: SongLyricsDeps): Promise<Found | null> {
  const kept = await deps.read(song.songKey);
  if (kept) {
    if (kept.lyrics) return { text: kept.lyrics, instrumental: false };
    if (kept.instrumental) return { text: '', instrumental: true };
    if (deps.now() - kept.checkedAt.getTime() < NOT_FOUND_TTL_MS) return null;      // looked for lately: not there
  }
  if (!deps.enabled()) return null;

  let answered = true;
  const tries: Wanted[] = [{ artist: song.artist, title: song.title, album: song.album ?? null }];
  const original = originalOf(song);
  if (original) tries.push(original);

  for (const wanted of tries) {
    const result = await deps.online(wanted);
    if (!result.answered) {
      answered = false;                                  // an outage: neither found nor «not there»
      continue;
    }
    if (result.kind === 'lyrics') {
      await deps.write(song.songKey, { lyrics: result.text, instrumental: false, sourceId: result.sourceId });
      logInfo('testo trovato su Internet', { songKey: song.songKey, viaOriginal: wanted !== tries[0] });
      return { text: result.text, instrumental: false };
    }
    // An instrumental of the song ITSELF counts; an instrumental «original» says nothing about this version.
    if (result.kind === 'instrumental' && wanted === tries[0]) {
      await deps.write(song.songKey, { lyrics: null, instrumental: true, sourceId: result.sourceId });
      return { text: '', instrumental: true };
    }
  }
  if (answered) await deps.write(song.songKey, { lyrics: null, instrumental: false, sourceId: null });
  return null;
}

/** What the Internet has for this song (kept, or searched now), or null. Never throws. */
export function internetLyrics(song: SongForLyrics, deps: SongLyricsDeps = realLyricsDeps): Promise<Found | null> {
  const running = inFlight.get(song.songKey);
  if (running) return running;
  const run = find(song, deps)
    .catch((err) => {
      logWarning('testi: errore', { songKey: song.songKey, err: String(err) });
      return null;
    })
    .finally(() => inFlight.delete(song.songKey));
  inFlight.set(song.songKey, run);
  return run;
}

/** The server's answer for a song: the transcript of its post if there is one, else the Internet's, else null. */
export async function lyricsFor(song: SongForLyrics, transcript: string | null, deps: SongLyricsDeps = realLyricsDeps): Promise<LyricsAnswer | null> {
  if (transcript && transcript.trim()) return { text: transcript, source: 'transcript', instrumental: false };
  const found = await internetLyrics(song, deps);
  return found ? { text: found.text, source: 'internet', instrumental: found.instrumental } : null;
}
