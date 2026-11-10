/**
 * The real sources of the front page of the site (`services/webHome.ts` has the rules, docs/web-home.md the contract).
 *
 * Every source is asked for the VIEWER the route resolved from the Authelia headers, with the same two values (`userId`, `isAdmin`) the
 * lists of the site are asked with, so what the Home shows is exactly what the posts, songs, films and playlists pages would show that
 * person: their own and what is shared with them, and for an admin also the anonymous ones. Nothing is kept from one request to the next.
 * The collections are the exception that is stricter, not looser: they are strictly PER USER (the posts of the person and those shared with
 * them), an administrator included.
 */
import type { Entry } from '../types';
import { listEntries, listEntrySummaries } from '../utils/db';
import { aggregateSongs, LIST_ENTRIES_LIMIT } from '../routes/songs';
import { aggregateFilms } from '../routes/films';
import { listSongMeta } from './songMeta';
import { listFilmMeta } from './filmMeta';
import { listPlaylists } from './playlists';
import { resolveSummaries } from './playlistResolver';
import { collectionList } from './collectionsView';
import { realViewSources, withCollectionChips } from './collectionsViewData';
import type { WebHomeDeps, WebHomeViewer } from './webHome';

const visibility = (viewer: WebHomeViewer) => ({ userId: viewer.userId, isAdmin: viewer.isAdmin });

/** One set of sources per REQUEST (the route makes it, and it is thrown away with the request). */
export function realWebHomeDeps(): WebHomeDeps {
  // The songs and the films come from the same journal, and reading it whole is the costly part of a cold Home (about half a second):
  // it is read once for the request, and once per viewer (a set of sources never answers one viewer with the journal of another).
  const journals = new Map<string, Promise<Entry[]>>();
  const journalOf = (viewer: WebHomeViewer): Promise<Entry[]> => {
    const key = `${viewer.userId}|${viewer.isAdmin ? 1 : 0}`;
    let journal = journals.get(key);
    if (!journal) {
      journal = listEntries(LIST_ENTRIES_LIMIT, visibility(viewer));
      journals.set(key, journal);
    }
    return journal;
  };

  return {
    // the rows are those of the list of entries, with the chips of the collections each post is in (a failure of the collections costs only the chips)
    posts: async (viewer, limit) => {
      const page = await listEntrySummaries(limit, 0, visibility(viewer));
      return { items: await withCollectionChips(page.items, viewer.userId), total: page.total };
    },
    async songs(viewer) {
      const [entries, meta] = await Promise.all([journalOf(viewer), listSongMeta()]);
      return [...aggregateSongs(entries, meta).values()];
    },
    async films(viewer) {
      const [entries, meta] = await Promise.all([journalOf(viewer), listFilmMeta()]);
      return [...aggregateFilms(entries, meta).values()];
    },
    playlists: (viewer) => listPlaylists(visibility(viewer)),
    resolvePlaylists: (list, viewer) => resolveSummaries(list, visibility(viewer)),
    collections: (viewer) => collectionList(viewer.userId, 'active', realViewSources(), new Date()),
  };
}
