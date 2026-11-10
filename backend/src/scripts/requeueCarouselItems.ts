/**
 * Rilegge le slide dei caroselli gia' analizzati e rimette in coda quelli che ci guadagnano dei brani.
 *
 * Fino all'11 novembre il passo che legge le slide di un carosello (`extractFromSlides`) chiedeva al modello un array JSON in modalita' JSON e il modello rispondeva con UN
 * OGGETTO per slide: il codice cercava `[...]`, non lo trovava e scartava la slide in silenzio. Sul diario vero, su 883 caroselli con testo OCR, UNO solo ha mai dato
 * un elemento (402 dicono `itemsFound: 0`, 480 sono antecedenti al passo e non ne hanno traccia): «album da ascoltare» con dieci dischi dava zero brani.
 *
 * Questo script lavora sui dati gia' salvati: il testo OCR di ogni slide sta in `results.slides[].ocrText`. Non scarica niente, non rifa' l'OCR, non chiama servizi esterni:
 * solo il nostro Ollama (una chiamata a slide, mezzo secondo l'una, un modello caldo). Per ogni carosello con abbastanza slide con testo e senza elementi trovati:
 *   - ANTEPRIMA (default): legge le slide con l'estrazione corretta e dice cosa troverebbe; niente scritto, niente in coda;
 *   - `--apply`: mette in coda (corsia seriale `reanalyze`, silenziosa salvo `--notify`) la seconda passata delle sole entry che guadagnano almeno `--min-items` brani o
 *     album. La seconda passata rilegge le slide salvate (regola di `routes/analyze.ts`), cerca i brani, li unisce a quelli dell'entry e fa partire quello che parte
 *     per ogni analisi finita: le playlist automatiche (un post che elenca almeno 2 brani dal contenuto ne fa una) e le raccolte. **Con l'OK di Michele e a lotti** (`--limit`).
 *
 * Usage (dentro il container):
 *   node dist/scripts/requeueCarouselItems.js --limit 20                     # anteprima sulle 20 piu' recenti
 *   node dist/scripts/requeueCarouselItems.js --since 2026-10-01             # anteprima da quel giorno
 *   node dist/scripts/requeueCarouselItems.js --apply --limit 20             # mette in coda quelle che ci guadagnano
 *   opzioni: --min-slides N (slide con testo, di partenza 3) --min-items N (brani o album, di partenza 2) --notify
 */
import type { Pool } from 'pg';
import type { EntrySlide } from '../types';
import { storedSlideOcrTexts, type SlideItem } from '../services/slideItems';

export interface Candidate {
  id: string;
  source_url: string;
  source_platform: string;
  input_user: string | null;
  slides: EntrySlide[];
}

export interface Options {
  apply: boolean;
  notify: boolean;
  since: string | null;
  limit: number | null;
  minSlides: number;
  minItems: number;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const positive = (flag: string, fallback: number | null): number | null => {
    const raw = value(flag);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} vuole un intero positivo, non "${raw}"`);
    return n;
  };
  const since = value('--since');
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since vuole YYYY-MM-DD, non "${since}"`);
  return {
    apply: argv.includes('--apply'),
    notify: argv.includes('--notify'),
    since,
    limit: positive('--limit', null),
    minSlides: positive('--min-slides', 3) as number,
    minItems: positive('--min-items', 2) as number,
  };
}

/** I caroselli con abbastanza slide con testo OCR e senza elementi trovati dall'ultimo passo (o senza passo), non gia' in coda, dal piu' recente. */
export async function fetchCandidates(db: Pick<Pool, 'query'>, opts: Pick<Options, 'since' | 'limit' | 'minSlides'>): Promise<Candidate[]> {
  const { rows } = await db.query<Candidate>(
    `SELECT e.id, e.source_url, e.source_platform, e.input_user, e.results->'slides' AS slides
       FROM entries e
      WHERE e.status = 'completed'
        AND jsonb_typeof(e.results->'slides') = 'array'
        AND (SELECT count(*) FROM jsonb_array_elements(e.results->'slides') s
              WHERE btrim(COALESCE(s->>'ocrText', '')) <> '') >= $1
        AND COALESCE((SELECT CASE WHEN a->'details'->>'itemsFound' ~ '^[0-9]+$' THEN (a->'details'->>'itemsFound')::int ELSE 0 END
                        FROM jsonb_array_elements(e.action_log) a
                       WHERE a->>'action' = 'carousel_extraction'
                       ORDER BY a->>'timestamp' DESC LIMIT 1), 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM job_queue j WHERE j.entry_id = e.id AND j.status IN ('queued', 'processing'))
        AND ($2::date IS NULL OR e.created_at >= $2::date)
      ORDER BY e.created_at DESC
      LIMIT COALESCE($3::int, 100000)`,
    [opts.minSlides, opts.since, opts.limit],
  );
  return rows;
}

export interface Deps {
  db: Pick<Pool, 'query'>;
  /** Legge le slide (il testo OCR gia' salvato) con l'estrazione di `aiAnalysis`. */
  extract: (slides: Array<{ slideIndex: number; text: string }>) => Promise<SlideItem[]>;
  enqueue: (job: {
    entryId: string;
    sourceUrl: string;
    platform: 'instagram' | 'other';
    chatId: number;
    inputUser: string | null;
    notify: boolean;
    reanalyze: boolean;
  }) => Promise<unknown>;
  /** Una riga nel registro dell'entry: quanti brani ha trovato la lettura che ha fatto mettere in coda. */
  record: (entryId: string, songs: number) => Promise<void>;
  say: (line: string) => void;
}

export interface Summary {
  candidates: number;
  /** Entry in cui la lettura ha trovato almeno un brano o un album. */
  withItems: number;
  /** Entry con almeno `minItems` brani o album: quelle che ci guadagnano. */
  enough: number;
  /** Brani e album trovati in tutto. */
  songs: number;
  queued: number;
  failed: number;
}

const isSong = (i: SlideItem): boolean => i.type === 'song' || i.type === 'album';

/** The chat the jobs answer to; it is also the value of the NOT NULL column when they are silent. */
async function resolveChatId(db: Pick<Pool, 'query'>): Promise<number> {
  const { rows } = await db.query<{ chat_id: string }>(`SELECT chat_id FROM job_queue GROUP BY chat_id ORDER BY count(*) DESC LIMIT 1`);
  return rows.length ? Number(rows[0].chat_id) : 0;
}

export async function requeueCarouselItems(deps: Deps, opts: Options): Promise<Summary> {
  const rows = await fetchCandidates(deps.db, opts);
  const summary: Summary = { candidates: rows.length, withItems: 0, enough: 0, songs: 0, queued: 0, failed: 0 };
  deps.say(
    `[carousel-items] ${opts.apply ? 'SCRIVE (--apply)' : 'ANTEPRIMA (niente in coda)'} | caroselli da rileggere: ${rows.length}` +
      `${opts.since ? ` (dal ${opts.since})` : ''}${opts.limit ? ` | al massimo ${opts.limit}` : ''} | almeno ${opts.minSlides} slide con testo e ${opts.minItems} brani`,
  );
  if (rows.length === 0) return summary;
  const chatId = opts.apply ? await resolveChatId(deps.db) : 0;

  for (const row of rows) {
    let items: SlideItem[];
    try {
      items = await deps.extract(storedSlideOcrTexts(row.slides));
    } catch (err) {
      summary.failed += 1;
      deps.say(`  ${row.id}  ERRORE ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const songs = items.filter(isSong);
    summary.songs += songs.length;
    if (songs.length > 0) summary.withItems += 1;
    const enough = songs.length >= opts.minItems;
    if (enough) summary.enough += 1;
    if (songs.length > 0) {
      deps.say(`  ${row.id}  ${songs.length} brani${enough ? '' : ' (meno del minimo)'}: ${songs.slice(0, 4).map((s) => `${s.title}${s.artist ? ` — ${s.artist}` : ''}`).join('; ')}${songs.length > 4 ? '…' : ''}`);
    }
    if (!opts.apply || !enough) continue;
    await deps.enqueue({
      entryId: row.id,
      sourceUrl: row.source_url,
      platform: row.source_platform === 'instagram' ? 'instagram' : 'other',
      chatId,
      inputUser: row.input_user,
      notify: opts.notify,
      // i dati sono gia' salvati: non si scarica niente, e il job va nella corsia seriale a modello caldo
      reanalyze: true,
    });
    await deps.record(row.id, songs.length);
    summary.queued += 1;
  }
  deps.say(
    `[carousel-items] letti ${rows.length} | con brani ${summary.withItems} | con almeno ${opts.minItems} ${summary.enough} | brani trovati ${summary.songs}` +
      `${opts.apply ? ` | messi in coda ${summary.queued}` : ' | niente in coda (aggiungi --apply)'}${summary.failed ? ` | errori ${summary.failed}` : ''}`,
  );
  return summary;
}

async function main(): Promise<void> {
  const [{ pool, appendActionLog, createActionLog }, { enqueueJob }, { extractFromSlides }] = await Promise.all([
    import('../utils/db'),
    import('../utils/jobQueue'),
    import('../services/aiAnalysis'),
  ]);
  try {
    await requeueCarouselItems(
      {
        db: pool,
        extract: (slides) => extractFromSlides(slides),
        enqueue: (job) => enqueueJob(job),
        record: async (entryId, songs) => {
          await appendActionLog(entryId, createActionLog('requeued_carousel_items', { songsFound: songs, silent: true }));
        },
        say: (line) => console.log(line),
      },
      parseArgs(process.argv.slice(2)),
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[carousel-items] errore fatale', err);
    process.exit(1);
  });
}
