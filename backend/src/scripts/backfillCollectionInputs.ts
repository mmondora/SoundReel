/**
 * Gives a vector, and the places and venues, to the entries of the library that do not have them yet (Raccolte, task 4; ADR-0022, spec
 * 2026-11-09-library-collections-auto-topics-design.md §5).
 *
 * New entries get them when their analysis ends (`services/collectionsWiring.ts`). The ~1700 already in the library do not: this runs the SAME rule over
 * them (`catchUpInputs`, so the decision of what is missing is the pipeline's own), one entry at a time and gently, because the router and the local
 * model are shared with the analyses. About 30 minutes for the whole library. Local models only (`nomic-embed-text`, `glm-4.7-flash`): no Claude, no
 * Instagram, nothing leaves the house.
 *
 * PREVIEW BY DEFAULT: without `--apply` nothing is asked of any model and nothing is written (it reads the entries and what is already recorded, and
 * prints how many need a vector and how many need their places read). With `--apply` it writes, ONLY with Michele's OK, in the container, once.
 *
 * Resumable and safe to run again: an entry whose recorded hashes match its text and the embedding model is skipped (an entry with no place at all is
 * remembered too); a failure on one entry is counted «da riprovare» and the run goes on; the second run finds nothing to do. A run by hand ignores
 * `COLLECTIONS_AUTO` (it is an explicit command: the switch stops the pipeline that runs after every analysis).
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillCollectionInputs.js                      # preview, every user
 *   node dist/scripts/backfillCollectionInputs.js --owner mike         # one user only
 *   node dist/scripts/backfillCollectionInputs.js --apply --limit 20   # the newest twenty that need something
 *   node dist/scripts/backfillCollectionInputs.js --apply              # all of them (~30 min)
 *   --delay-ms N                                                       # pause between two entries (default 300)
 */
import { catchUpInputs, DEFAULT_CATCH_UP_DELAY_MS, type CatchUpDeps, type CatchUpSummary } from '../services/collectionsWiring';

export interface Options {
  apply: boolean;
  limit: number | null;
  owner: string | null;
  delayMs: number;
}

const FLAGS_WITH_VALUE = new Set(['--limit', '--owner', '--delay-ms']);
const FLAGS_ALONE = new Set(['--apply', '--dry-run']);

export function parseArgs(argv: string[]): Options {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS_WITH_VALUE.has(arg)) {
      i++; // its value is checked below
      continue;
    }
    if (!FLAGS_ALONE.has(arg)) throw new Error(`opzione sconosciuta: "${arg}"`);
  }
  const value = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    const next = argv[at + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} vuole un valore`);
    return next;
  };
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('--apply e --dry-run insieme: scegline uno (senza niente è già un\'anteprima)');
  const rawLimit = value('--limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit vuole un intero positivo, non "${rawLimit}"`);
  const rawDelay = value('--delay-ms');
  const delayMs = rawDelay === null ? DEFAULT_CATCH_UP_DELAY_MS : Number(rawDelay);
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error(`--delay-ms vuole un intero, zero o più, non "${rawDelay}"`);
  return { apply: argv.includes('--apply'), limit, owner: value('--owner'), delayMs };
}

export interface ScriptDeps extends CatchUpDeps {
  say(line: string): void;
}

const voci = (n: number): string => `${n} ${n === 1 ? 'voce' : 'voci'}`;

/** The run: the header, the loop of `catchUpInputs` (which talks about the entries that fail), and one line of totals. */
export async function backfillCollectionInputs(deps: ScriptDeps, opts: Options): Promise<CatchUpSummary> {
  deps.say(
    `[collezioni] VETTORI, LUOGHI E LOCALI: ${opts.owner ?? 'tutti gli utenti'} | ${opts.apply ? 'SCRIVE (--apply)' : 'ANTEPRIMA (nessun modello chiamato, niente scritto)'}` +
      `${opts.limit ? ` | al massimo ${opts.limit}` : ''}`,
  );
  const summary = await catchUpInputs(deps, { apply: opts.apply, limit: opts.limit, owner: opts.owner, delayMs: opts.delayMs });
  const rest = `già a posto: ${summary.upToDate}, senza testo: ${summary.noText}, guardate: ${summary.scanned}`;
  if (opts.apply) {
    deps.say(`[collezioni] fatto: ${voci(summary.done)}, da riprovare: ${summary.pending}, ${rest}`);
  } else {
    deps.say(`[collezioni] da fare: ${voci(summary.needAny)} (vettore: ${summary.needVector}, luoghi: ${summary.needPlaces}), ${rest}`);
  }
  return summary;
}

async function main(): Promise<void> {
  const [{ pool }, { realCatchUpDeps }] = await Promise.all([import('../utils/db'), import('../services/collectionsWiring')]);
  const options = parseArgs(process.argv.slice(2));
  try {
    await backfillCollectionInputs({ ...realCatchUpDeps((line) => console.log(line)), say: (line) => console.log(line) }, options);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[collezioni] errore fatale', err);
    process.exit(1);
  });
}
