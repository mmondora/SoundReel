/**
 * One-off backfill: re-extract content for entries the local Ollama model left
 * completely empty, using the Claude CLI fallback.
 *
 * Works ONLY from data already stored in Postgres (caption, transcript, OCR
 * overlay text, visual context) — it never re-scrapes Instagram, so it carries
 * no ban or rate-limit risk against the source platform.
 *
 * Idempotent and resumable: an entry stops matching the "empty" query as soon
 * as it is fixed, so re-running picks up only what is still outstanding.
 *
 * Usage (inside the container, where the CLI and token live):
 *   node dist/scripts/backfillAnalysis.js            # process everything
 *   node dist/scripts/backfillAnalysis.js --dry-run  # list, change nothing
 *   node dist/scripts/backfillAnalysis.js --limit 5  # process the first N
 */
import { pool, updateEntry, appendActionLog, createActionLog } from '../utils/db';
import { buildAnalysisPrompt, parseAnalysisResponse, isEmptyAnalysis, type AiAnalysisInput } from '../services/aiAnalysis';
import { runClaudePrompt } from '../services/claudeFallback';
import { searchFilm, generateImdbUrl, generateStreamingUrls } from '../services/filmSearch';
import { searchTrack, generateYoutubeSearchUrl, generateSoundcloudSearchUrl } from '../services/spotify';
import type { Entry, Film, Song, EntryResults } from '../types';

/** Matches the live cascade's threshold so both agree on what is worth retrying. */
const MIN_SOURCE_TEXT = 40;

/** Pause between entries: keeps a long run from hammering the API. */
const DELAY_MS = 1_000;

interface Row {
  id: string;
  caption: string | null;
  results: EntryResults;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf('--limit');
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null,
  };
}

/** Rebuild the analysis input from what the pipeline already persisted. */
function toAnalysisInput(row: Row): AiAnalysisInput {
  const r = row.results;
  return {
    caption: row.caption,
    musicInfo: null,
    transcript: r.transcript || r.transcription || null,
    transcriptLanguage: null,
    ocrText: r.overlayText || null,
    visualContext: r.visualContext || null,
    slidePaths: [],
    thumbnailPath: null,
  };
}

function sourceTextLength(input: AiAnalysisInput): number {
  return [input.caption, input.ocrText, input.transcript].filter(Boolean).join(' ').trim().length;
}

async function fetchEmptyEntries(limit: number | null): Promise<Row[]> {
  // Mirrors isEmptyAnalysis(): tags/links do not count as success, and neither
  // does a song identified purely from the audio track — Instagram attaches a
  // background song to most posts, so counting it as success hid 128 failed
  // analyses from this very script.
  const { rows } = await pool.query<Row>(
    `SELECT id, caption, results
       FROM entries
      WHERE status = 'completed'
        AND COALESCE(results->>'summary', '') = ''
        AND COALESCE(jsonb_array_length(results->'films'), 0) = 0
        AND COALESCE(jsonb_array_length(results->'notes'), 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(results->'songs', '[]'::jsonb)) AS s
           WHERE s->>'source' IS DISTINCT FROM 'audio_fingerprint'
        )
      ORDER BY created_at DESC
      ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

/** Same TMDb enrichment the live pipeline applies, so backfilled films get posters and links. */
async function enrichFilms(raw: Array<{ title: string; director: string | null; year: string | null }>): Promise<Film[]> {
  const films: Film[] = [];
  for (const f of raw) {
    const tmdb = await searchFilm(f.title, f.year);
    films.push({
      title: f.title,
      director: f.director ?? null,
      year: f.year || tmdb?.releaseDate?.split('-')[0] || null,
      imdbUrl: tmdb?.imdbId ? generateImdbUrl(tmdb.imdbId) : null,
      posterUrl: tmdb?.posterPath || null,
      streamingUrls: generateStreamingUrls(f.title),
    });
  }
  return films;
}

/**
 * Same Spotify/YouTube resolution as the live pipeline, minus the playlist add:
 * silently pushing 200+ backfilled tracks into the user's playlist would be a
 * surprising side effect of a data-repair run.
 */
async function enrichSongs(raw: Array<{ title: string; artist: string; album: string | null }>): Promise<Song[]> {
  const songs: Song[] = [];
  for (const s of raw) {
    const spotify = await searchTrack(s.title, s.artist);
    songs.push({
      title: s.title,
      artist: s.artist,
      album: s.album ?? null,
      source: 'ai_analysis',
      spotifyUri: spotify?.uri || null,
      spotifyUrl: spotify?.url || null,
      youtubeUrl: generateYoutubeSearchUrl(s.title, s.artist),
      soundcloudUrl: generateSoundcloudSearchUrl(s.title, s.artist),
      addedToPlaylist: false,
    });
  }
  return songs;
}

/** Append items absent from `existing`, comparing on a caller-supplied key. */
function addNew<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const seen = new Set(existing.map(key));
  return [...existing, ...incoming.filter((item) => !seen.has(key(item)))];
}

/**
 * Merge re-analysis output into a stored result **without ever removing
 * anything**. A repair pass must only ever add: it re-reads text and knows
 * nothing about what the original run learned from the audio track, the media
 * files or a manual edit, so replacing an array would silently destroy data
 * this script cannot reconstruct.
 *
 * Every field is therefore either a union with what is already stored, or
 * fill-only-if-absent. Nothing is overwritten.
 */
export function mergeAdditive(
  existing: EntryResults,
  incoming: {
    songs: Song[];
    films: Film[];
    notes: EntryResults['notes'];
    tags: string[];
    links: EntryResults['links'];
    summary: string | null;
  }
): EntryResults {
  return {
    ...existing,
    songs: addNew(existing.songs ?? [], incoming.songs, (s) => `${s.artist}|${s.title}`.toLowerCase()),
    films: addNew(existing.films ?? [], incoming.films, (f) => `${f.title}|${f.year ?? ''}`.toLowerCase()),
    notes: addNew(existing.notes ?? [], incoming.notes, (n) => n.text.trim().toLowerCase()),
    tags: addNew(existing.tags ?? [], incoming.tags, (t) => t.trim().toLowerCase()),
    links: addNew(existing.links ?? [], incoming.links, (l) => l.url),
    // Fill only when missing — never replace a summary that already exists.
    summary: existing.summary || incoming.summary,
  };
}

async function main(): Promise<void> {
  const { dryRun, limit } = parseArgs();
  const model = process.env.CLAUDE_FALLBACK_MODEL || '(default)';

  const rows = await fetchEmptyEntries(limit);
  const candidates = rows.filter((r) => sourceTextLength(toAnalysisInput(r)) >= MIN_SOURCE_TEXT);
  const skipped = rows.length - candidates.length;

  console.log(`[backfill] entry vuote: ${rows.length} | recuperabili: ${candidates.length} | senza testo: ${skipped}`);
  console.log(`[backfill] modello: ${model}${dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`);

  if (dryRun) {
    for (const row of candidates) {
      console.log(`  ${row.id}  ${sourceTextLength(toAnalysisInput(row))} char`);
    }
    await pool.end();
    return;
  }

  let recovered = 0;
  let stillEmpty = 0;
  let failed = 0;

  for (const [i, row] of candidates.entries()) {
    const n = `${i + 1}/${candidates.length}`;
    const input = toAnalysisInput(row);

    try {
      const prompt = await buildAnalysisPrompt(input);
      const res = await runClaudePrompt(prompt);

      if (res.status !== 'ok' || !res.text) {
        failed++;
        console.log(`[${n}] ${row.id} — FALLITO (${res.status}: ${res.reason})`);
        await appendActionLog(row.id, createActionLog('backfill_analysis', {
          status: res.status, reason: res.reason, model: res.model, durationMs: res.durationMs,
        }));
        continue;
      }

      const parsed = parseAnalysisResponse(res.text, input);
      if (isEmptyAnalysis(parsed) || !parsed) {
        stillEmpty++;
        console.log(`[${n}] ${row.id} — nulla da estrarre`);
        await appendActionLog(row.id, createActionLog('backfill_analysis', {
          status: 'empty', model: res.model, durationMs: res.durationMs,
        }));
        continue;
      }

      const films = await enrichFilms(parsed.films);
      const extractedSongs = await enrichSongs(parsed.songs);

      const merged = mergeAdditive(row.results, {
        songs: extractedSongs,
        films,
        notes: parsed.notes,
        tags: parsed.tags,
        links: parsed.links,
        summary: parsed.summary,
      });

      await updateEntry(row.id, { results: merged as unknown as Entry['results'] });
      await appendActionLog(row.id, createActionLog('backfill_analysis', {
        status: 'ok',
        model: res.model,
        durationMs: res.durationMs,
        // Report what this pass added, not the entry totals.
        added: {
          songs: merged.songs.length - (row.results.songs?.length ?? 0),
          films: merged.films.length - (row.results.films?.length ?? 0),
          notes: merged.notes.length - (row.results.notes?.length ?? 0),
          hasSummary: !!merged.summary,
        },
      }));

      recovered++;
      const addedSongs = merged.songs.length - (row.results.songs?.length ?? 0);
      const addedFilms = merged.films.length - (row.results.films?.length ?? 0);
      const addedNotes = merged.notes.length - (row.results.notes?.length ?? 0);
      console.log(`[${n}] ${row.id} — OK: +${addedSongs} songs, +${addedFilms} films, +${addedNotes} notes${merged.summary ? ', summary' : ''}`);
    } catch (err) {
      failed++;
      console.log(`[${n}] ${row.id} — ERRORE: ${String(err)}`);
    }

    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n[backfill] fatto — recuperate: ${recovered} | nulla da estrarre: ${stillEmpty} | fallite: ${failed}`);
  await pool.end();
}

// Only run when invoked directly; importing this module (e.g. to unit-test
// mergeAdditive) must not start a backfill.
if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill] errore fatale', err);
    process.exit(1);
  });
}
