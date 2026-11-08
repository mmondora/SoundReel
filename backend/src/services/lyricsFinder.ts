/**
 * Lyrics from the Internet (ADR-0021, spec 2026-11-08-lyrics-from-the-internet-design.md L3–L6). The SERVER asks; the app never talks
 * to an archive of lyrics (rule P).
 *
 * The archive is LRCLIB (open, no key) through its search endpoint. What goes out is the artist and the title and nothing else.
 * The answer is trusted only with a STRONG match: the same title (once the markers in brackets or after a dash — «(feat. X)»,
 * «(Remastered 2011)», «- Radio Edit» — are taken off) and a credited artist in common, with case, accents and punctuation folded.
 * Better no text than the words of another song: a wrong text looks right.
 *
 * `answered: false` means the archive could not be asked (HTTP error, network): an outage is not an answer, and the caller must not
 * remember «no lyrics» because of it.
 */
import { creditsOf } from '../utils/credits';
import { logWarning } from '../utils/logger';

export const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
/** The requests to the archive are at least this far apart (one queue for the whole server). */
export const MIN_INTERVAL_MS = 1000;
/** A «text» shorter than this is a stub («la la la»), not lyrics worth showing as the words of a song. */
export const MIN_LYRICS_CHARS = 20;
const MAX_LYRICS_CHARS = 30_000;
const MAX_RESULTS = 15;

/** What the archive sends for one track: the fields used here. */
export interface LyricsCandidate {
  id?: number;
  trackName?: string;
  name?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
}

export type OnlineLyrics =
  | { answered: false }
  | { answered: true; kind: 'none' }
  | { answered: true; kind: 'instrumental'; sourceId: string | null }
  | { answered: true; kind: 'lyrics'; text: string; sourceId: string | null };

export interface Wanted {
  artist: string;
  title: string;
  album?: string | null;
}

// ---------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------

/** Lower case, no accents, no punctuation, one space between words (any script: letters and digits of every alphabet stay). */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')                                  // «Don't» and «Dont» are the same word
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The title without its markers, or '' when nothing is left: «Song (feat. X) [Live]» → «Song», «Song - 2011 Remaster» → «Song». */
function removeMarkers(title: string): string {
  let t = title;
  let prev: string;
  do {
    prev = t;
    t = t.replace(/\s*[(\[][^()[\]]*[)\]]/g, ' ');
  } while (t !== prev);
  t = t.replace(/\s+[-–—]\s+.*$/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** The title as a person reads it, without the markers (the whole title when only markers would be left): what is searched. */
export function stripMarkers(title: string): string {
  return removeMarkers(title) || title.trim();
}

/** What two titles must have in common: the folded title without markers. Empty when nothing is left to compare. */
export function titleCore(title: string): string {
  return fold(removeMarkers(title));
}

function creditKeys(artist: string): Set<string> {
  return new Set([fold(artist), ...creditsOf(artist).map(fold)].filter(Boolean));
}

/** A credited name in common: «Hell Raton, Ensi» and «Hell Raton» agree; «Simon & Garfunkel» stays one name. */
export function sameArtist(candidateArtist: string, wantedArtist: string): boolean {
  const candidate = creditKeys(candidateArtist);
  for (const key of creditKeys(wantedArtist)) if (candidate.has(key)) return true;
  return false;
}

export function isSameSong(candidate: LyricsCandidate, wanted: Wanted): boolean {
  if (!wanted.artist.trim()) return false;                       // an empty artist matches everybody: no match at all
  const want = titleCore(wanted.title);
  const got = titleCore(candidate.trackName ?? candidate.name ?? '');
  if (!want || want !== got) return false;
  return sameArtist(candidate.artistName ?? '', wanted.artist);
}

const cleanText = (raw: string): string =>
  raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_LYRICS_CHARS);

/**
 * The best text among what the archive sent, or an instrumental, or nothing. Among the texts of the same song the one on the wanted
 * album comes first, then the order the archive gave (its own relevance). An instrumental counts only when no version of the song
 * has words.
 */
export function pickLyrics(results: LyricsCandidate[], wanted: Wanted): OnlineLyrics {
  const same = results.filter((r) => isSameSong(r, wanted));
  const withText = same.filter((r) => !r.instrumental && typeof r.plainLyrics === 'string' && cleanText(r.plainLyrics).length >= MIN_LYRICS_CHARS);
  if (withText.length > 0) {
    const album = wanted.album ? fold(wanted.album) : '';
    const best = (album && withText.find((r) => fold(r.albumName ?? '') === album)) || withText[0];
    return { answered: true, kind: 'lyrics', text: cleanText(best.plainLyrics as string), sourceId: best.id !== undefined ? String(best.id) : null };
  }
  const instrumental = same.find((r) => r.instrumental === true);
  if (instrumental) return { answered: true, kind: 'instrumental', sourceId: instrumental.id !== undefined ? String(instrumental.id) : null };
  return { answered: true, kind: 'none' };
}

// ---------------------------------------------------------------------------
// Asking the archive
// ---------------------------------------------------------------------------

export interface LyricsFetchDeps {
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
}

const defaultDeps = (): LyricsFetchDeps => ({
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  userAgent: process.env.LYRICS_USER_AGENT || 'SoundReel/2 (private family music journal; lyrics lookup)',
});

let lastCall = -Infinity;
let queue: Promise<void> = Promise.resolve();

/** Test-only: forgets the last request so a test does not wait for the gap left by another. */
export function _resetLyricsThrottle(): void {
  lastCall = -Infinity;
  queue = Promise.resolve();
}

/** One place in the single line to the archive: the requests go out one at a time, at least `MIN_INTERVAL_MS` apart. */
function slot(deps: LyricsFetchDeps): Promise<void> {
  const mine = queue.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    lastCall = deps.now();
  });
  queue = mine.catch(() => undefined);
  return mine;
}

/** The archive's answer to one search: its results, `[]` when it has nothing, `null` when it could not be asked (not an answer). */
export async function searchLrclib(artist: string, title: string, deps: LyricsFetchDeps = defaultDeps()): Promise<LyricsCandidate[] | null> {
  const lead = creditsOf(artist)[0] ?? artist;
  const params = new URLSearchParams({ track_name: stripMarkers(title), artist_name: lead });
  try {
    await slot(deps);
    const res = await deps.fetch(`${LRCLIB_SEARCH}?${params.toString()}`, {
      headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logWarning('testi: l\'archivio ha risposto con un errore', { status: res.status });
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as LyricsCandidate[]).slice(0, MAX_RESULTS) : [];
  } catch (err) {
    logWarning('testi: l\'archivio non risponde', { err: String(err) });
    return null;
  }
}

/** The lyrics of a song from the Internet, with a strong match only. Never throws. */
export async function findLyricsOnline(wanted: Wanted, deps?: LyricsFetchDeps): Promise<OnlineLyrics> {
  // Nothing to match strongly (no artist, or a title that is only markers): not worth asking.
  if (!wanted.artist.trim() || !titleCore(wanted.title)) return { answered: true, kind: 'none' };
  const results = await searchLrclib(wanted.artist, wanted.title, deps);
  if (results === null) return { answered: false };
  return pickLyrics(results, wanted);
}
