/**
 * Rimette in coda l'analisi AI delle entry che ne sono uscite senza niente.
 *
 * Dal 2 novembre (modello glm-4.7-flash, e niente piu' Claude sulle risposte vuote) il modello locale rispondeva con
 * una chiave inventata o andava in loop fino al tetto di token, e l'entry risultava "completata" a zero: 33 su 91 in una
 * settimana, e altre 200 e passa piu' vecchie. Il rimedio (schema imposto, un nuovo tentativo, fallimento dichiarato e
 * ritentabile) vale per le entry nuove; questo script riprende quelle gia' rotte.
 *
 * "Vuota" come in `isEmptyAnalysis()` e in `backfillAnalysis`: niente riassunto, niente film, niente note, niente
 * software, nessun brano che non venga dalla sola traccia audio. Hashtag e link da soli non contano: un post con del
 * testo ha sempre un riassunto, se manca l'analisi non c'e' stata. Restano fuori:
 *   - le entry senza abbastanza testo (nulla da analizzare);
 *   - quelle che Claude ha gia' giudicato vuote (`backfill_analysis` con `status: empty`);
 *   - quelle gia' in coda;
 *   - le voci di libreria Shazam, che non passano dall'analisi.
 *
 * Non tocca Instagram: lavora sui dati gia' salvati, come `requeueAiPass`. I job vanno nella corsia seriale
 * `reanalyze` (un modello caldo, un'entry alla volta), silenziosi (niente Telegram) salvo `--notify`.
 *
 * Usage (dentro il container):
 *   node dist/scripts/requeueEmptyAnalysis.js --dry-run                 # elenca, non cambia niente
 *   node dist/scripts/requeueEmptyAnalysis.js --limit 3                 # prova su 3 (le piu' recenti)
 *   node dist/scripts/requeueEmptyAnalysis.js --since 2026-11-02        # solo dopo quel giorno
 *   node dist/scripts/requeueEmptyAnalysis.js                           # tutte
 */
import type { Pool } from 'pg';

export const MIN_TEXT = 40;

export interface EmptyEntry {
  id: string;
  source_url: string;
  source_platform: string;
  input_user: string | null;
  text_chars: number;
}

export interface Options {
  dryRun: boolean;
  notify: boolean;
  /** Solo le entry create da questo giorno (YYYY-MM-DD) in poi. */
  since: string | null;
  limit: number | null;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const since = value('--since');
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since vuole YYYY-MM-DD, non "${since}"`);
  const rawLimit = value('--limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit vuole un intero positivo, non "${rawLimit}"`);
  return { dryRun: argv.includes('--dry-run'), notify: argv.includes('--notify'), since, limit };
}

export async function fetchEmptyEntries(db: Pick<Pool, 'query'>, opts: Pick<Options, 'since' | 'limit'>): Promise<EmptyEntry[]> {
  const { rows } = await db.query<EmptyEntry>(
    `SELECT e.id, e.source_url, e.source_platform, e.input_user,
            GREATEST(length(COALESCE(e.caption, '')),
                     length(COALESCE(e.results->>'transcript', '')),
                     length(COALESCE(e.results->>'overlayText', ''))) AS text_chars
       FROM entries e
      WHERE e.status = 'completed'
        AND e.source_platform <> 'shazam'
        AND COALESCE(e.results->>'summary', '') = ''
        AND COALESCE(jsonb_array_length(e.results->'films'), 0) = 0
        AND COALESCE(jsonb_array_length(e.results->'notes'), 0) = 0
        AND COALESCE(jsonb_array_length(e.results->'software'), 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(e.results->'songs', '[]'::jsonb)) s
           WHERE s->>'source' IS DISTINCT FROM 'audio_fingerprint')
        AND (length(COALESCE(e.caption, '')) >= $1
             OR length(COALESCE(e.results->>'transcript', '')) >= $1
             OR length(COALESCE(e.results->>'overlayText', '')) >= $1)
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(e.action_log) a
           WHERE a->>'action' = 'backfill_analysis' AND a->'details'->>'status' = 'empty')
        AND NOT EXISTS (
          SELECT 1 FROM job_queue j WHERE j.entry_id = e.id AND j.status IN ('queued', 'processing'))
        AND ($2::date IS NULL OR e.created_at >= $2::date)
      ORDER BY e.created_at DESC
      LIMIT COALESCE($3::int, 100000)`,
    [MIN_TEXT, opts.since, opts.limit],
  );
  return rows;
}

export interface Deps {
  db: Pick<Pool, 'query'>;
  enqueue: (job: {
    entryId: string;
    sourceUrl: string;
    platform: 'instagram' | 'other';
    chatId: number;
    inputUser: string | null;
    notify: boolean;
    reanalyze: boolean;
  }) => Promise<unknown>;
  record: (entryId: string, platform: string, silent: boolean) => Promise<void>;
  say: (line: string) => void;
}

/** The chat the jobs answer to; it is also the value of the NOT NULL column when they are silent. */
async function resolveChatId(db: Pick<Pool, 'query'>): Promise<number> {
  const { rows } = await db.query<{ chat_id: string }>(`SELECT chat_id FROM job_queue GROUP BY chat_id ORDER BY count(*) DESC LIMIT 1`);
  return rows.length ? Number(rows[0].chat_id) : 0;
}

export async function requeueEmptyAnalysis(deps: Deps, opts: Options): Promise<{ found: number; queued: number }> {
  const rows = await fetchEmptyEntries(deps.db, opts);
  deps.say(
    `[empty-analysis] entry senza analisi: ${rows.length}` +
      `${opts.since ? ` (dal ${opts.since})` : ''}${opts.limit ? ` | al massimo ${opts.limit}` : ''}` +
      ` | corsia seriale, silenziose ${opts.notify ? 'NO (con Telegram)' : 'si'}${opts.dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`,
  );
  if (opts.dryRun || rows.length === 0) {
    if (opts.dryRun) for (const r of rows) deps.say(`  ${r.id}  ${r.source_platform}  ${r.text_chars} char`);
    return { found: rows.length, queued: 0 };
  }

  const chatId = await resolveChatId(deps.db);
  let queued = 0;
  for (const row of rows) {
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
    await deps.record(row.id, row.source_platform, !opts.notify);
    queued++;
  }
  deps.say(`[empty-analysis] accodate: ${queued}`);
  return { found: rows.length, queued };
}

async function main(): Promise<void> {
  const [{ pool, appendActionLog, createActionLog }, { enqueueJob }] = await Promise.all([import('../utils/db'), import('../utils/jobQueue')]);
  try {
    await requeueEmptyAnalysis(
      {
        db: pool,
        enqueue: (job) => enqueueJob(job),
        record: async (entryId, platform, silent) => {
          await appendActionLog(entryId, createActionLog('requeued_empty_analysis', { platform, silent }));
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
    console.error('[empty-analysis] errore fatale', err);
    process.exit(1);
  });
}
