/**
 * Le playlist di genere che non esistono ancora, a mano (ADR-0024, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.14).
 *
 * Il controllo giornaliero del server (`services/genrePlaylistSweep.ts`, il primo giro due minuti dopo l'avvio, poi ogni 24 ore) fa nascere la
 * playlist DINAMICA di ogni genere che ha almeno due brani in libreria e nessuna playlist: la stessa che avrebbe fatto un post di quel tema.
 * Michele, 10 novembre: «Le playlist di genere Latina (8 brani), Techno (4), Blues (4) e Metal (2) non esistono ancora, perché nessun post con quel
 * tema è passato. Un controllo una volta al giorno le fa nascere subito, senza aspettare il post. Lo faccio?» — «Sì, controllo giornaliero».
 * Questo script fa lo STESSO giro quando serve (o per vedere cosa farebbe), con lo stesso codice.
 *
 * Una playlist che c'e' non si tocca; una che l'utente ha CANCELLATO (il tema resta nel registro senza playlist) non si rifa' mai; un genere con un
 * solo brano aspetta il secondo. Nessun modello e nessun servizio esterno: il titolo e' la parola del tema + « da ascoltare».
 *
 * ANTEPRIMA PER DEFAULT: senza `--apply` non scrive niente (legge i temi e la libreria e stampa cosa farebbe, per utente e per genere: mai i brani).
 * Con `--apply` scrive, **solo con l'OK di Michele**, e manda un messaggio in Posta per ogni playlist nata (come il giro giornaliero). A mano ignora
 * `AUTO_PLAYLISTS` (e' un comando esplicito): il giro giornaliero invece si spegne con `AUTO_PLAYLISTS=0`.
 *
 * Per tornare indietro: una playlist nata di qui si cancella dal sito come ogni altra (e da quel momento non si rifa'); per farla rinascere si toglie
 * la riga del tema da `auto_playlist_themes`.
 *
 * Usage (dentro il container):
 *   node dist/scripts/ensureGenrePlaylists.js                  # anteprima, tutti gli utenti che hanno voci
 *   node dist/scripts/ensureGenrePlaylists.js --owner mike     # solo un utente
 *   node dist/scripts/ensureGenrePlaylists.js --apply          # scrive davvero
 */
import { MIN_PLAYLIST_SONGS } from '../services/autoPlaylists';
import { ensureGenrePlaylists, planGenreSweep, sweepOwners, type GenreSweepRunDeps, type SweepItem } from '../services/genrePlaylistSweep';

export interface Options {
  apply: boolean;
  owner: string | null;
}

export function parseArgs(argv: string[]): Options {
  const at = argv.indexOf('--owner');
  const owner = at >= 0 ? argv[at + 1] : null;
  if (at >= 0 && (!owner || owner.startsWith('--'))) throw new Error('--owner vuole il nome di un utente');
  return { apply: argv.includes('--apply'), owner: owner ?? null };
}

export interface ScriptDeps extends GenreSweepRunDeps {
  say(line: string): void;
}

export interface ScriptSummary {
  owners: number;
  /** Le playlist che nascono (anteprima) o che sono nate (`--apply`). */
  toCreate: number;
  created: number;
  hasPlaylist: number;
  deleted: number;
  /** Generi con un brano solo: aspettano il secondo. */
  waiting: number;
  /** Generi senza nessun brano: niente da aspettare (una riga sola per utente). */
  noSongs: number;
  failed: number;
}

const brani = (n: number): string => `${n} ${n === 1 ? 'brano' : 'brani'}`;
const pad = (word: string): string => word.padEnd(10);

function lineOf(item: SweepItem, apply: boolean): string {
  const title = `«${item.theme.title}»`;
  if (item.action === 'create') return `  ${pad(apply ? 'creata' : 'nasce')} ${title}  ${brani(item.matching ?? 0)} col tag ${item.theme.genres.join(' / ')}`;
  if (item.action === 'failed') return `  ${pad('ERRORE')} ${title}  ${item.error ?? ''}`;
  if (item.reason === 'has_playlist') return `  ${pad("c'e' gia'")} ${title}`;
  if (item.reason === 'deleted_by_user') return `  ${pad('cancellata')} ${title}  l'hai cancellata: non si rifa'`;
  return `  ${pad('aspetta')} ${title}  ${brani(item.matching ?? 0)} col tag: ne servono ${MIN_PLAYLIST_SONGS}`;
}

/** Lo stesso giro del server, per gli utenti scelti: anteprima (`planGenreSweep`, sola lettura) o scrittura (`ensureGenrePlaylists`). */
export async function ensureGenrePlaylistsScript(deps: ScriptDeps, opts: Options): Promise<ScriptSummary> {
  const owners = sweepOwners(opts.owner ? [opts.owner] : await deps.listOwners());
  const summary: ScriptSummary = { owners: 0, toCreate: 0, created: 0, hasPlaylist: 0, deleted: 0, waiting: 0, noSongs: 0, failed: 0 };
  deps.say(`[genre-sweep] PLAYLIST DI GENERE: ${owners.length} ${owners.length === 1 ? 'utente' : 'utenti'} | ${opts.apply ? 'SCRIVE (--apply)' : 'ANTEPRIMA (niente scritto)'}`);
  if (owners.length === 0) deps.say('  nessun utente con voci da guardare');
  for (const owner of owners) {
    summary.owners++;
    deps.say(`utente ${owner}:`);
    try {
      let items: SweepItem[];
      if (opts.apply) {
        const out = await ensureGenrePlaylists(owner, deps);
        items = out.items;
        summary.created += out.created;
      } else {
        items = await planGenreSweep(owner, deps);
      }
      // a genre with no song at all has nothing to wait with: they are named together, in one line
      const empty: string[] = [];
      for (const item of items) {
        if (item.action === 'skip' && item.reason === 'too_few_songs' && !item.matching) {
          empty.push(item.theme.word);
          summary.noSongs++;
          continue;
        }
        deps.say(lineOf(item, opts.apply));
        if (item.action === 'create') summary.toCreate++;
        else if (item.action === 'failed') summary.failed++;
        else if (item.reason === 'has_playlist') summary.hasPlaylist++;
        else if (item.reason === 'deleted_by_user') summary.deleted++;
        else summary.waiting++;
      }
      if (empty.length > 0) deps.say(`  nessun brano col tag: ${empty.join(', ')}`);
    } catch (err) {
      summary.failed++;
      deps.say(`ERRORE utente ${owner}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  deps.say(
    `[genre-sweep] ${opts.apply ? 'fatto' : 'da fare'}: ${opts.apply ? plural(summary.toCreate, 'creata', 'create') : plural(summary.toCreate, 'nasce', 'nascono')}, ` +
      `${summary.hasPlaylist === 1 ? "1 c'e' gia'" : `${summary.hasPlaylist} ci sono gia'`}, ${plural(summary.deleted, 'cancellata', 'cancellate')}, ` +
      `${plural(summary.waiting, 'aspetta', 'aspettano')}, ${summary.noSongs} senza brani${summary.failed ? `, ${summary.failed} in errore` : ''}`,
  );
  return summary;
}

async function main(): Promise<void> {
  const [{ pool }, { realGenreSweepDeps }] = await Promise.all([import('../utils/db'), import('../services/genrePlaylistSweepWiring')]);
  const options = parseArgs(process.argv.slice(2));
  try {
    await ensureGenrePlaylistsScript({ ...realGenreSweepDeps(), say: (line) => console.log(line) }, options);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[genre-sweep] errore fatale', err);
    process.exit(1);
  });
}
