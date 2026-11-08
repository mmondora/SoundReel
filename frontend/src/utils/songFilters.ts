import type { AggregatedSong } from '../types';

export type ListenedFilter = 'all' | 'listened' | 'unlistened';
export type DownloadedFilter = 'all' | 'yes' | 'no';

export interface SongFilterOptions {
  genres: string[];
  listened: ListenedFilter;
  /** true = show only favorites; false = no favorite filtering. */
  favorite: boolean;
  downloaded: DownloadedFilter;
  /** true = show only liked (rating like or score ≥ 80); false = no liked filtering. */
  liked?: boolean;
  /** Case-insensitive containment search over title, artist, album. Empty/omitted = no filtering. */
  text?: string;
}

function songIsDownloaded(song: AggregatedSong): boolean {
  return song.inLibrary === true || (song.meta?.downloaded ?? false);
}

function songIsLiked(song: AggregatedSong): boolean {
  const meta = song.meta;
  if (!meta) return false;
  if (meta.rating === 'like') return true;
  return meta.score != null && meta.score >= 80;
}

export function filterSongs<T extends AggregatedSong>(songs: T[], opts: SongFilterOptions): T[] {
  const query = opts.text?.trim().toLowerCase() ?? '';
  return songs.filter((song) => {
    if (opts.genres.length > 0) {
      const genres = song.meta?.genres ?? [];
      if (!opts.genres.some((g) => genres.includes(g))) return false;
    }
    if (opts.listened !== 'all') {
      const listened = song.meta?.listened ?? false;
      if (opts.listened === 'listened' && !listened) return false;
      if (opts.listened === 'unlistened' && listened) return false;
    }
    if (opts.favorite) {
      const favorite = song.meta?.favorite ?? false;
      if (!favorite) return false;
    }
    if (opts.liked) {
      if (!songIsLiked(song)) return false;
    }
    if (opts.downloaded !== 'all') {
      const downloaded = songIsDownloaded(song);
      if (opts.downloaded === 'yes' && !downloaded) return false;
      if (opts.downloaded === 'no' && downloaded) return false;
    }
    if (query) {
      const haystack = [song.title, song.artist, song.album, song.meta?.album];
      if (!haystack.some((field) => field != null && field.toLowerCase().includes(query))) return false;
    }
    return true;
  });
}

export function collectGenres(songs: AggregatedSong[]): string[] {
  const set = new Set<string>();
  for (const song of songs) for (const g of song.meta?.genres ?? []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export type SongSortMode = 'date' | 'mentions' | 'artist';

function latestMentionTime(song: AggregatedSong): number {
  return song.mentions[0] ? new Date(song.mentions[0].createdAt).getTime() : 0;
}

/**
 * Sort modes: 'date' = most recent mention first (default); 'mentions' =
 * mention count desc, ties by most recent mention; 'artist' = artist
 * alphabetical (songs without an artist last), ties by most recent mention.
 */
export function sortSongs<T extends AggregatedSong>(songs: T[], mode: SongSortMode): T[] {
  const byDate = (a: T, b: T) => latestMentionTime(b) - latestMentionTime(a);
  const sorted = [...songs];
  if (mode === 'mentions') {
    sorted.sort((a, b) => b.mentions.length - a.mentions.length || byDate(a, b));
  } else if (mode === 'artist') {
    sorted.sort((a, b) => {
      const aa = a.artist.trim();
      const ba = b.artist.trim();
      if (aa === '' && ba === '') return byDate(a, b);
      if (aa === '') return 1;
      if (ba === '') return -1;
      return aa.localeCompare(ba) || byDate(a, b);
    });
  } else {
    sorted.sort(byDate);
  }
  return sorted;
}
