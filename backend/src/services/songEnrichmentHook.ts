import { songKey, getSongMeta, upsertSongEnrichment } from './songMeta';
import { enrichSong } from './songEnrichment';
import { isStale } from './streamingRefresher';
import { logError } from '../utils/logger';

const SONG_ENRICHMENT_TTL_DAYS = Number(process.env.SONG_ENRICHMENT_TTL_DAYS || 30);

/**
 * Fire-and-forget: enrich every given song (Deezer/iTunes cover, genres,
 * direct links) skipping ones enriched within the TTL. Never delays the
 * caller. Shared by the analyze main flow, music_list_auto, and the
 * /api/music-list/process route so all three persist songs the same way.
 */
export function enqueueSongEnrichment(songs: Array<{ artist: string | null; title: string }>): void {
  for (const song of songs) {
    if (!song.title.trim()) continue;
    const artist = song.artist ?? '';
    const songMetaKey = songKey(artist, song.title);
    void (async () => {
      const existingMeta = await getSongMeta(songMetaKey);
      if (existingMeta?.enrichedAt && !isStale(existingMeta.enrichedAt, SONG_ENRICHMENT_TTL_DAYS)) return;
      const enrichment = await enrichSong(artist, song.title);
      if (enrichment) {
        await upsertSongEnrichment({ songKey: songMetaKey, ...enrichment });
      }
    })().catch((err) => logError('song enrichment failed', { err: String(err) }));
  }
}
