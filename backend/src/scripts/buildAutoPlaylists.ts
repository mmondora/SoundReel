/**
 * Le playlist automatiche per le voci che ci sono GIA' nella libreria (ADR-0023, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.6).
 *
 * Dal 2.20.0 un post che elenca delle canzoni diventa una playlist da solo, quando la sua analisi finisce. Le voci salvate prima non sono mai
 * passate di li': questo script le riprende, dalla piu' VECCHIA, con le stesse regole e lo stesso modello locale (mai Claude), cosi' i temi
 * generici finiscono con i brani piu' nuovi in cima e ogni playlist ha la data del suo post.
 *
 * Tutte le voci con canzoni (10 novembre, Michele: «vorrei di tutti i post non solo di 42 già salvati»): quelle che ELENCANO musica (2 o piu' brani dal
 * contenuto) fanno una playlist a se' o entrano in un tema; quelle con UNA canzone (nominata o riconosciuta dall'audio) entrano in un tema per genere,
 * ma solo se il post parla davvero di musica (il sottofondo di una ricetta no).
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
 *   AUTO_PLAYLIST_MODEL=gpt-oss:120b node dist/scripts/buildAutoPlaylists.js --apply   # titoli da un modello piu' grande (vedi il ripiego)
 *
 * ANNULLARE un'applicazione (anteprima per default, `--apply` toglie davvero): le playlist automatiche nate da corse con `processed_at` dal
 * momento dato in poi, le loro corse e i loro temi (le voci si possono rifare):
 *   node dist/scripts/buildAutoPlaylists.js --undo-since 2026-11-10T02:00:00Z [--apply]
 */
import type { Entry } from '../types';
import {
  MemoryAutoPlaylistStore,
  processEntry,
  songsFor,
  type AutoOutcome,
  type AutoPlaylistStore,
} from '../services/autoPlaylists';
import type { TitlePlan, TitleSource } from '../services/autoPlaylistTitle';

export interface Options {
  apply: boolean;
  owner: string | null;
  limit: number | null;
  /** ISO moment: undo what the runs from then on made (a preview unless `apply`). */
  undoSince: string | null;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const rawLimit = value('--limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit vuole un intero positivo, non "${rawLimit}"`);
  const undoSince = value('--undo-since');
  if (undoSince !== null && !Number.isFinite(Date.parse(undoSince))) throw new Error(`--undo-since vuole una data (ISO), non "${undoSince}"`);
  return { apply: argv.includes('--apply'), owner: value('--owner'), limit, undoSince };
}

export interface Deps {
  /** Le voci con canzoni, dalla piu' vecchia. */
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
  /** Quante hanno UNA canzone (finiscono in un tema) e quante ne elencano di piu'. */
  singles: number;
  lists: number;
  created: number;
  joined: number;
  pending: number;
  skipped: number;
  songs: number;
}

const day = (e: Entry): string => String(e.createdAt).slice(0, 10);

export async function buildAutoPlaylists(deps: Deps, opts: Options): Promise<Summary> {
  const found = (await deps.candidates(opts)).filter((e) => songsFor(e) !== null);
  const entries = opts.limit ? found.slice(0, opts.limit) : found;
  const singles = entries.filter((e) => songsFor(e)?.mode === 'single').length;
  deps.say(
    `[auto-playlists] voci con canzoni: ${entries.length} (${entries.length - singles} ne elencano piu' di una, ${singles} ne hanno una sola)` +
      `${opts.owner ? ` | utente ${opts.owner}` : ''} | ${opts.apply ? 'SCRIVE (--apply)' : 'ANTEPRIMA (niente scritto)'}`,
  );
  const store = await deps.store(opts.apply);
  const language = await deps.language();
  const summary: Summary = { candidates: entries.length, singles, lists: entries.length - singles, created: 0, joined: 0, pending: 0, skipped: 0, songs: 0 };
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
        `  ${day(entry)}  ${entry.id}  ${outcome.kind === 'theme' ? 'tema    ' : 'preciso '}${outcome.mode === 'single' ? ' (1 canzone)' : ''} «${outcome.title}»  ` +
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

export interface UndoDeps {
  /** The automatic playlists that the runs from `since` on made (the entry that made each was run from then on). */
  findMade(since: Date): Promise<Array<{ id: string; name: string; ownerUser: string; themeKey: string | null }>>;
  countRuns(since: Date): Promise<number>;
  /** Takes the playlists away, with their runs and their themes (so the posts can be made again). */
  remove(since: Date, playlists: Array<{ id: string; ownerUser: string; themeKey: string | null }>): Promise<void>;
  say(line: string): void;
}

/**
 * Undoes an application: the automatic playlists that the runs from `since` on made, those runs and those themes. A PREVIEW unless `apply`.
 * It takes away a playlist even if the user has since renamed or changed it: look at the preview first.
 */
export async function undoAutoPlaylists(deps: UndoDeps, opts: { since: string; apply: boolean }): Promise<{ playlists: number; runs: number }> {
  const since = new Date(opts.since);
  const made = await deps.findMade(since);
  const runs = await deps.countRuns(since);
  deps.say(`[auto-playlists] ANNULLA dal ${since.toISOString()}: ${made.length} playlist automatiche, ${runs} corse | ${opts.apply ? 'TOGLIE (--apply)' : 'ANTEPRIMA (niente tolto)'}`);
  for (const p of made.slice(0, 300)) deps.say(`    «${p.name}»`);
  if (opts.apply && (made.length > 0 || runs > 0)) await deps.remove(since, made);
  return { playlists: made.length, runs };
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
    if (options.undoSince) {
      await undoAutoPlaylists(
        {
          findMade: async (since) => {
            const rows = await query<{ id: string; name: string; owner_user: string; theme_key: string | null }>(
              `SELECT p.id, p.name, p.owner_user, p.theme_key FROM playlists p
                WHERE p.origin = 'auto'
                  AND p.source_entry_id IN (SELECT entry_id FROM auto_playlist_runs WHERE processed_at >= $1 AND status = 'done')
                ORDER BY p.created_at ASC`,
              [since],
            );
            return rows.map((r) => ({ id: r.id, name: r.name, ownerUser: r.owner_user, themeKey: r.theme_key }));
          },
          countRuns: async (since) => (await query<{ n: string }>(`SELECT count(*) AS n FROM auto_playlist_runs WHERE processed_at >= $1`, [since]))[0]?.n as unknown as number,
          remove: async (since, playlists) => {
            if (playlists.length > 0) await pool.query(`DELETE FROM playlists WHERE id = ANY($1::text[])`, [playlists.map((p) => p.id)]);
            await pool.query(`DELETE FROM auto_playlist_runs WHERE processed_at >= $1`, [since]);
            for (const p of playlists) {
              if (p.themeKey) await pool.query(`DELETE FROM auto_playlist_themes WHERE owner_user = $1 AND theme_key = $2`, [p.ownerUser, p.themeKey]);
            }
          },
          say: (line) => console.log(line),
        },
        { since: options.undoSince, apply: options.apply },
      );
      return;
    }
    await buildAutoPlaylists(
      {
        candidates: async ({ owner, limit }) => {
          const rows = await query<{ id: string }>(
            `SELECT e.id FROM entries e
              WHERE e.status = 'completed' AND jsonb_array_length(COALESCE(e.results->'songs', '[]'::jsonb)) >= 1
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
