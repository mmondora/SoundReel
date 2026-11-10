/**
 * Where the automatic playlists meet the rest of the server: the real database, the local model, the inbox, and the moment an analysis
 * ends (ADR-0023). Kept apart from `autoPlaylists.ts` so that the rules stay pure and testable.
 */
import { getEntry, getFeaturesConfig } from '../utils/db';
import { canonicalGenres } from '../utils/genres';
import { logWarning } from '../utils/logger';
import { createInboxItem } from './inbox';
import { announceInboxItem } from './inboxAnnouncer';
import { processEntry, type AutoOutcome, type AutoPlaylistDeps } from './autoPlaylists';
import { PgAutoPlaylistStore } from './autoPlaylistStore';
import { generatePlaylistTitle } from './autoPlaylistTitle';
import { getUserSongs } from './userSongs';

/** `AUTO_PLAYLISTS=0` stops the whole thing (the playlists already made stay). */
export const autoPlaylistsEnabled = (): boolean => process.env.AUTO_PLAYLISTS !== '0';

/**
 * How many songs of the owner's library carry one of these (canonical) genres: what the rule of the playlist of a genre will select, so the
 * playlist is born only when there are two (ADR-0024). The same eyes as the rule: the songs the owner can see, their genres canonicalised.
 */
export async function countGenreSongs(owner: string, genres: string[]): Promise<number> {
  const wanted = new Set(genres);
  const songs = await getUserSongs(owner, false);
  let count = 0;
  for (const song of songs.values()) if (canonicalGenres(song.meta?.genres).some((g) => wanted.has(g))) count++;
  return count;
}

export function realAutoPlaylistDeps(): AutoPlaylistDeps {
  return {
    store: new PgAutoPlaylistStore(),
    getEntry,
    countGenreSongs,
    title: (source) => generatePlaylistTitle(source),
    language: async () => {
      try {
        return (await getFeaturesConfig()).outputLanguage === 'en' ? 'en' : 'it';
      } catch {
        return 'it';
      }
    },
    announce: async (item) => {
      // an `info` that goes away after 3 days (ADR-0015); the push is only the doorbell and is off until the APNs key exists
      const created = await createInboxItem({ userId: item.userId, kind: 'auto_playlist', level: 'info', title: item.title, body: item.body, entryId: item.entryId });
      try {
        await announceInboxItem(created);
      } catch {
        // the doorbell only: the message is in the inbox anyway
      }
    },
  };
}

// One at a time: two analyses that end together and belong to the same theme must not both make it (the database would stop the second,
// but then it would have waited for the model for nothing).
let chain: Promise<unknown> = Promise.resolve();

/**
 * Called when an analysis ends well. Never throws and is not meant to be awaited: the title comes from the local model and nothing
 * else (the Telegram answer, the share outcome) waits for it. Does nothing when the kill switch is on.
 */
export function onEntryAnalyzed(entryId: string, deps: AutoPlaylistDeps = realAutoPlaylistDeps()): Promise<AutoOutcome | null> {
  if (!autoPlaylistsEnabled()) return Promise.resolve(null);
  const next = chain
    .then(() => processEntry(entryId, deps))
    .catch((err: unknown) => {
      logWarning('automatic playlist failed (the analysis is done anyway)', { entryId, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
  chain = next;
  return next;
}
