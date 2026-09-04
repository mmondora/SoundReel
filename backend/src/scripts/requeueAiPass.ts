/**
 * Seconda passata: analizza in blocco le entry che il download ha lasciato
 * senza AI.
 *
 * La prima passata (requeueErrors --skip-ai) scarica e basta, spaziata di
 * decine di minuti perche' Instagram non sfidi di nuovo l'account. Questa
 * non tocca Instagram — lavora sui file gia' a terra — quindi puo' correre
 * serrata: i job finiscono tutti nella corsia `reanalyze`, che il worker
 * serve uno alla volta e senza jitter, e ollama carica il modello una volta
 * sola per l'intero blocco invece di una volta per job.
 *
 * Le entry si riconoscono dall'actionLog: l'ultimo `ai_analyzed` dice
 * `reason: deferred to the batched AI pass`. Chi ha gia' avuto la sua
 * analisi non viene ripreso.
 *
 * Usage (dentro il container):
 *   node dist/scripts/requeueAiPass.js --dry-run
 *   node dist/scripts/requeueAiPass.js
 */
import { pool, appendActionLog, createActionLog } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';

interface Row {
  id: string;
  source_url: string;
  source_platform: string;
  input_user: string | null;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  return { dryRun: argv.includes('--dry-run'), notify: argv.includes('--notify') };
}

/**
 * Entry la cui analisi e' stata rimandata e non e' ancora arrivata.
 *
 * L'ordine dell'actionLog conta: un'entry ripresa e analizzata ha un
 * `ai_analyzed` piu' recente senza quel `reason`, e non deve tornare in coda.
 */
async function fetchDeferredEntries(): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT e.id, e.source_url, e.source_platform, e.input_user
       FROM entries e
      WHERE (
        SELECT a->'details'->>'reason'
          FROM jsonb_array_elements(e.action_log) WITH ORDINALITY AS t(a, ord)
         WHERE a->>'action' = 'ai_analyzed'
         ORDER BY ord DESC
         LIMIT 1
      ) = 'deferred to the batched AI pass'
        AND NOT EXISTS (
          SELECT 1 FROM job_queue j
           WHERE j.entry_id = e.id AND j.status IN ('queued', 'processing')
        )
      ORDER BY e.created_at ASC`
  );
  return rows;
}

/** Il chat a cui i job rispondono; e' anche il valore della colonna NOT NULL quando sono muti. */
async function resolveChatId(): Promise<number> {
  const { rows } = await pool.query<{ chat_id: string }>(
    `SELECT chat_id FROM job_queue GROUP BY chat_id ORDER BY count(*) DESC LIMIT 1`
  );
  return rows.length ? Number(rows[0].chat_id) : 0;
}

async function main(): Promise<void> {
  const { dryRun, notify } = parseArgs();

  const rows = await fetchDeferredEntries();
  const chatId = await resolveChatId();

  console.log(
    `[ai-pass] entry con analisi rimandata: ${rows.length} | corsia seriale, ollama caldo ` +
    `| ${notify ? 'con notifica Telegram' : 'silenziose'}${dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`
  );

  if (!rows.length) {
    await pool.end();
    return;
  }

  let queued = 0;
  for (const row of rows) {
    if (dryRun) {
      console.log(`  ${row.id}  ${row.source_platform}`);
      continue;
    }

    await enqueueJob({
      entryId: row.id,
      sourceUrl: row.source_url,
      platform: row.source_platform === 'instagram' ? 'instagram' : 'other',
      chatId,
      inputUser: row.input_user,
      notify,
      // Il punto dell'intera passata: i media sono gia' sul disco, non si
      // scarica niente. Manda anche il job nella corsia seriale.
      reanalyze: true,
      // Tutti pronti subito: la corsia ne serve uno alla volta, e la coda che
      // si forma e' esattamente cio' che tiene il modello caricato.
    });
    await appendActionLog(row.id, createActionLog('requeued_for_ai_pass', {
      platform: row.source_platform,
      silent: !notify,
    }));
    queued++;
  }

  if (!dryRun) console.log(`\n[ai-pass] accodate: ${queued}`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ai-pass] errore fatale', err);
    process.exit(1);
  });
}
