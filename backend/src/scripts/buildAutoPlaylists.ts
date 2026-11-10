/**
 * Le playlist automatiche per le voci che ci sono GIA' nella libreria (ADR-0023, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.6).
 *
 * Dal 2.20.0 un post che elenca delle canzoni diventa una playlist da solo, quando la sua analisi finisce. Le voci salvate prima non sono mai
 * passate di li': questo script le riprende, dalla piu' VECCHIA, con le stesse regole e lo stesso modello locale (mai Claude), cosi' i temi
 * generici finiscono con i brani piu' nuovi in cima e ogni playlist ha la data del suo post.
 *
 * ANTEPRIMA PER DEFAULT: senza `--apply` non scrive niente (le playlist si fanno in memoria e si stampano: titolo, tipo, brani, mai il testo dei
 * post). Con `--apply` scrive, **solo con l'OK di Michele**, e manda UN messaggio in Posta per utente (non uno per playlist).
 * Le voci gia' viste (fatte, saltate) non si rivedono; quelle `pending` (nessun titolo buono) si riprovano.
 *
 * Usage (dentro il container):
 *   node dist/scripts/buildAutoPlaylists.js                   # anteprima, tutti gli utenti
 *   node dist/scripts/buildAutoPlaylists.js --owner mike      # solo le voci di un utente
 *   node dist/scripts/buildAutoPlaylists.js --limit 10        # prova sulle prime 10 (le piu' vecchie)
 *   node dist/scripts/buildAutoPlaylists.js --apply           # scrive davvero
 */
import type { Entry } from '../types';
import {
  MemoryAutoPlaylistStore,
  processEntry,
  talksAboutMusic,
  type AutoOutcome,
  type AutoPlaylistStore,
} from '../services/autoPlaylists';
import type { TitlePlan, TitleSource } from '../services/autoPlaylistTitle';

export interface Options {
  apply: boolean;
  owner: string | null;
  limit: number | null;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const rawLimit = value('--limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit vuole un intero positivo, non "${rawLimit}"`);
  return { apply: argv.includes('--apply'), owner: value('--owner'), limit };
}

export interface Deps {
  /** Le voci che parlano di musica, dalla piu' vecchia. */
  candidates(opts: Pick<Options, 'owner' | 'limit'>): Promise<Entry[]>;
  /** Lo store su cui lavorare: quello vero con `--apply`, uno in memoria (con i temi e le voci gia' viste) per l'anteprima. */
  store(apply: boolean): Promise<AutoPlaylistStore>;
  title(source: TitleSource): Promise<TitlePlan | null>;
  language(): Promise<'it' | 'en'>;
  /** Un solo messaggio per utente, dopo `--apply`. */
  tellOwner(owner: string, made: { playlists: number; songs: number }): Promise<void>;
  say(line: string): void;
}

export interface Summary {
  candidates: number;
  created: number;
  joined: number;
  pending: number;
  skipped: number;
  songs: number;
}

const day = (e: Entry): string => String(e.createdAt).slice(0, 10);

export async function buildAutoPlaylists(deps: Deps, opts: Options): Promise<Summary> {
  const found = (await deps.candidates(opts)).filter(talksAboutMusic);
  const entries = opts.limit ? found.slice(0, opts.limit) : found;
  deps.say(
    `[auto-playlists] voci che parlano di musica: ${entries.length}` +
      `${opts.owner ? ` | utente ${opts.owner}` : ''} | ${opts.apply ? 'SCRIVE (--apply)' : 'ANTEPRIMA (niente scritto)'}`,
  );
  const store = await deps.store(opts.apply);
  const language = await deps.language();
  const summary: Summary = { candidates: entries.length, created: 0, joined: 0, pending: 0, skipped: 0, songs: 0 };
  const perOwner = new Map<string, { playlists: number; songs: number }>();
  const playlists = new Map<string, { title: string; kind: string; songs: number }>();

  for (const entry of entries) {
    const outcome: AutoOutcome = await processEntry(
      entry,
      { store, getEntry: async () => entry, title: deps.title, language: async () => language, announce: async () => undefined },
      { announce: false },
    );
    if (outcome.status === 'done') {
      summary.songs += outcome.added;
      const made = perOwner.get(entry.ownerUser) ?? { playlists: 0, songs: 0 };
      made.songs += outcome.added;
      if (outcome.created) {
        summary.created++;
        made.playlists++;
      } else summary.joined++;
      perOwner.set(entry.ownerUser, made);
      const row = playlists.get(outcome.playlistId) ?? { title: outcome.title, kind: outcome.kind, songs: 0 };
      row.songs += outcome.added;
      playlists.set(outcome.playlistId, row);
      deps.say(
        `  ${day(entry)}  ${entry.id}  ${outcome.kind === 'theme' ? 'tema    ' : 'preciso '} «${outcome.title}»  ` +
          `${outcome.created ? `${outcome.added} brani (nuova)` : `+${outcome.added} brani (nella stessa playlist)`}`,
      );
    } else if (outcome.status === 'pending') {
      summary.pending++;
      deps.say(`  ${day(entry)}  ${entry.id}  nessun titolo buono (si riprova)`);
    } else {
      summary.skipped++;
      deps.say(`  ${day(entry)}  ${entry.id}  saltata (${outcome.reason})`);
    }
  }

  deps.say(`[auto-playlists] playlist: ${summary.created} nuove, ${summary.joined} voci in playlist di un tema, ${summary.pending} senza titolo, ${summary.skipped} saltate | brani messi dentro: ${summary.songs}`);
  for (const p of [...playlists.values()].sort((a, b) => b.songs - a.songs)) {
    deps.say(`    «${p.title}» (${p.kind === 'theme' ? 'tema' : 'preciso'}): ${p.songs} brani`);
  }
  if (opts.apply) {
    for (const [owner, made] of perOwner) if (made.playlists > 0) await deps.tellOwner(owner, made);
  }
  return summary;
}

async function main(): Promise<void> {
  const [{ pool, getEntry, query }, { PgAutoPlaylistStore }, { generatePlaylistTitle }, { createInboxItem }, { realAutoPlaylistDeps }] = await Promise.all([
    import('../utils/db'),
    import('../services/autoPlaylistStore'),
    import('../services/autoPlaylistTitle'),
    import('../services/inbox'),
    import('../services/autoPlaylistWiring'),
  ]);
  const options = parseArgs(process.argv.slice(2));
  try {
    await buildAutoPlaylists(
      {
        candidates: async ({ owner, limit }) => {
          const rows = await query<{ id: string }>(
            `SELECT e.id FROM entries e
              WHERE e.status = 'completed' AND jsonb_array_length(COALESCE(e.results->'songs', '[]'::jsonb)) >= 2
                AND ($1::text IS NULL OR e.owner_user = $1)
              ORDER BY e.created_at ASC
              LIMIT COALESCE($2::int, 100000)`,
            [owner, limit ? limit * 5 : null],
          );
          const out: Entry[] = [];
          for (const row of rows) {
            const entry = await getEntry(row.id);
            if (entry) out.push(entry);
          }
          return out;
        },
        store: async (apply) => {
          if (apply) return new PgAutoPlaylistStore();
          // anteprima: in memoria, ma con i temi che ci sono gia' (per entrarci dentro) e le voci gia' viste (per non rivederle)
          const real = new PgAutoPlaylistStore();
          const owners = await query<{ owner_user: string }>(`SELECT DISTINCT owner_user FROM entries`);
          const themes: Array<{ owner: string; themeKey: string; title: string; playlistId: string | null }> = [];
          for (const { owner_user: owner } of owners) for (const t of await real.listThemes(owner)) themes.push({ owner, ...t });
          const memory = new MemoryAutoPlaylistStore({ themes });
          const seen = await query<{ entry_id: string; owner_user: string; status: string; playlist_id: string | null; reason: string | null }>(
            `SELECT entry_id, owner_user, status, playlist_id, reason FROM auto_playlist_runs WHERE status <> 'pending'`,
          );
          for (const r of seen) await memory.saveRun(r.entry_id, r.owner_user, { status: r.status === 'done' ? 'done' : 'skipped', playlistId: r.playlist_id, reason: r.reason });
          return memory;
        },
        title: (source) => generatePlaylistTitle(source),
        language: realAutoPlaylistDeps().language,
        tellOwner: async (owner, made) => {
          await createInboxItem({
            userId: owner,
            kind: 'auto_playlist',
            level: 'info',
            title: `Ho creato ${made.playlists} ${made.playlists === 1 ? 'playlist' : 'playlist'} dai tuoi post`,
            body: `${made.songs} brani in tutto, dai post che parlano di musica`,
          });
        },
        say: (line) => console.log(line),
      },
      options,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[auto-playlists] errore fatale', err);
    process.exit(1);
  });
}
