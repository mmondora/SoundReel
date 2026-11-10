import type {
  Entry, EntrySummary, SearchResponse, EnrichmentResult, AggregatedFilm, FilmMetaRecord, AvailabilityStatus,
  AggregatedSong, SongMetaRecord, SongRating, AggregatedNote, AggregatedSoftware,
  PlaylistSummary, PlaylistDetail, PlaylistFilter, PlaylistSort, PlaylistPage, JournalStats, MeResponse, SongStateResponse, SongDownloadResponse,
  DynamicPreset, DynamicRule, PlayEvent, PlayPlan,
  LibraryScope, LibrarySearchResponse, MusicFoldersPayload, MusicFolderInput, FolderBrowse,
} from '../types';

// When served from the same origin as the backend, relative paths work.
// For local dev against a backend on :8080, set VITE_API_BASE_URL in .env.local.
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

function url(path: string): string {
  return `${API_BASE}${path}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// --- Analyze ---

export interface AnalyzeResponse {
  success: boolean;
  entryId: string;
  existing?: boolean;
  entry?: Entry;
  error?: string;
}

export async function analyzeUrl(sourceUrl: string): Promise<AnalyzeResponse> {
  const res = await fetch(url('/api/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: sourceUrl }),
  });
  // A failed pipeline now answers with a non-2xx *and* the usual body — the
  // status is what tells the queue worker to retry instead of marking the job
  // done. The UI still wants the body: `useAnalyze` renders `error` off a
  // `success: false` response, and would otherwise show the raw JSON.
  if (!res.ok) {
    const body = (await res.clone().json().catch(() => null)) as AnalyzeResponse | null;
    if (body && body.success === false) return body;
  }
  return json<AnalyzeResponse>(res);
}

// --- Entries ---

export async function listEntries(limit = 200): Promise<Entry[]> {
  const res = await fetch(url(`/api/entries?limit=${limit}`));
  return json<Entry[]>(res);
}

export interface EntrySummaryPage {
  entries: EntrySummary[];
  total: number;
  limit: number;
  offset: number;
}

export async function listEntrySummaries(limit = 40, offset = 0): Promise<EntrySummaryPage> {
  const params = new URLSearchParams({
    view: 'summary',
    limit: String(limit),
    offset: String(offset),
  });
  const res = await fetch(url(`/api/entries?${params}`));
  return json<EntrySummaryPage>(res);
}

/** Every entry summary visible to the user (pages of 1000, the backend cap). */
export async function fetchAllEntrySummaries(pageSize = 1000): Promise<EntrySummary[]> {
  const all: EntrySummary[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await listEntrySummaries(pageSize, offset);
    all.push(...page.entries);
    if (page.entries.length === 0 || all.length >= page.total) break;
  }
  return all;
}

export async function fetchJournalStats(): Promise<JournalStats> {
  const res = await fetch(url('/api/stats'));
  const data = await json<{ stats: JournalStats }>(res);
  return data.stats;
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch(url('/api/me'));
  return json<MeResponse>(res);
}

export async function shareEntryWith(
  entryId: string,
  withUsers: string[],
): Promise<{ entryId: string; sharedWith: string[] }> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(entryId)}/share`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ with: withUsers }),
  });
  return json(res);
}

export async function unshareEntryWith(
  entryId: string,
  withUser: string,
): Promise<{ entryId: string; sharedWith: string[] }> {
  const params = new URLSearchParams({ with: withUser });
  const res = await fetch(
    url(`/api/entries/${encodeURIComponent(entryId)}/share?${params}`),
    { method: 'DELETE' },
  );
  return json(res);
}

export async function fetchEntryShares(
  entryId: string,
): Promise<{ entryId: string; sharedWith: string[]; family: string[] }> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(entryId)}/shares`));
  return json(res);
}

export async function getEntry(id: string): Promise<Entry> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(id)}`));
  return json<Entry>(res);
}

export interface EntryMediaUrls {
  entryId: string;
  videoUrl: string | null;
  audioUrl: string | null;
  thumbnailUrl: string | null;
  frames: string[];
  slides: string[];
}

export async function fetchEntryMedia(entryId: string): Promise<EntryMediaUrls> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(entryId)}/media`));
  return json<EntryMediaUrls>(res);
}

export interface LibraryItem {
  entryId: string;
  sourceUrl: string;
  sourcePlatform: string;
  createdAt: string;
  caption: string | null;
  summary: string | null;
  videoUrl: string | null;
  audioUrl: string | null;
  thumbnailUrl: string | null;
  frameCount: number;
  slideCount: number;
}

export async function fetchLibrary(limit = 60): Promise<LibraryItem[]> {
  const res = await fetch(url(`/api/library?limit=${limit}`));
  const data = await json<{ items: LibraryItem[] }>(res);
  return data.items;
}

export async function deleteEntry(entryId: string): Promise<{ success: boolean }> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(entryId)}`), { method: 'DELETE' });
  return json<{ success: boolean }>(res);
}

export async function deleteAllEntries(): Promise<{ success: boolean; deleted: number }> {
  const res = await fetch(url('/api/entries'), { method: 'DELETE' });
  return json<{ success: boolean; deleted: number }>(res);
}

export async function retryEntry(entryId: string, sourceUrl: string): Promise<AnalyzeResponse> {
  await deleteEntry(entryId);
  return analyzeUrl(sourceUrl);
}

export async function enrichEntry(entryId: string): Promise<{ success: boolean; enrichment: EnrichmentResult }> {
  const res = await fetch(url('/api/entries/enrich'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });
  return json<{ success: boolean; enrichment: EnrichmentResult }>(res);
}

// --- SSE stream (real-time updates) ---

export type EntryStreamEvent = { op: 'INSERT' | 'UPDATE' | 'DELETE'; id: string };

export function openEntryStream(onEvent: (event: EntryStreamEvent) => void, onError?: (err: Event) => void): () => void {
  const es = new EventSource(url('/api/entries/stream'));
  es.addEventListener('entry_changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as EntryStreamEvent;
      onEvent(data);
    } catch {}
  });
  es.addEventListener('error', (ev) => onError?.(ev));
  return () => es.close();
}

// --- Config ---

export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
  mediaAnalysisEnabled: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
  pageExtractionEnabled: boolean;
  shazamEnabled: boolean;
  multiSongScanEnabled: boolean;
  youtubeDirect: boolean;
  carouselStructuredExtraction: boolean;
  /** Lingua dei testi generati dall'AI (summary, slide, note). */
  outputLanguage: 'it' | 'en';
}

export async function getFeatures(): Promise<FeaturesConfig> {
  const res = await fetch(url('/api/config/features'));
  return json<FeaturesConfig>(res);
}

export async function updateFeatures(updates: Partial<FeaturesConfig>): Promise<{ success: boolean; config: FeaturesConfig }> {
  const res = await fetch(url('/api/config/features'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const config = await json<FeaturesConfig>(res);
  return { success: true, config };
}

export interface InstagramConfigResponse {
  sessionId: string | null;
  csrfToken: string | null;
  dsUserId: string | null;
  enabled: boolean;
  hasCredentials: boolean;
}

export async function getInstagramConfig(): Promise<InstagramConfigResponse> {
  const res = await fetch(url('/api/config/instagram'));
  const raw = await json<Omit<InstagramConfigResponse, 'hasCredentials'>>(res);
  return { ...raw, hasCredentials: !!(raw.sessionId && raw.csrfToken && raw.dsUserId) };
}

export async function updateInstagramConfig(updates: Partial<InstagramConfigResponse>): Promise<{ success: boolean; config: InstagramConfigResponse }> {
  const res = await fetch(url('/api/config/instagram'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const raw = await json<Omit<InstagramConfigResponse, 'hasCredentials'>>(res);
  const config = { ...raw, hasCredentials: !!(raw.sessionId && raw.csrfToken && raw.dsUserId) };
  return { success: true, config };
}

export interface OpenAIConfigResponse {
  apiKey: string | null;
  enabled: boolean;
  hasKey: boolean;
}

export async function getOpenAIConfig(): Promise<OpenAIConfigResponse> {
  const res = await fetch(url('/api/config/openai'));
  const raw = await json<Omit<OpenAIConfigResponse, 'hasKey'>>(res);
  return { ...raw, hasKey: !!raw.apiKey };
}

export async function updateOpenAIConfig(updates: { apiKey?: string; enabled?: boolean }): Promise<{ success: boolean; config: OpenAIConfigResponse }> {
  const res = await fetch(url('/api/config/openai'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const raw = await json<Omit<OpenAIConfigResponse, 'hasKey'>>(res);
  const config = { ...raw, hasKey: !!raw.apiKey };
  return { success: true, config };
}

// --- Spotify ---

export interface SpotifyStatus {
  connected: boolean;
  playlistId: string | null;
}

export interface SpotifyTrack {
  uri: string;
  url: string;
  name: string;
  artist: string;
  albumName: string | null;
  albumImageUrl: string | null;
}

export async function getSpotifyStatus(): Promise<SpotifyStatus> {
  const res = await fetch(url('/api/spotify/status'));
  return json<SpotifyStatus>(res);
}

export function spotifyAuthorizeUrl(): string {
  return url('/api/spotify/authorize');
}

export async function searchSpotifyTracks(q: string, limit = 5): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(url(`/api/spotify/search?${params}`));
  if (res.status === 503) return [];   // Spotify not connected — surface as empty results
  return json<SpotifyTrack[]>(res);
}

export async function addSongToSpotify(
  entryId: string,
  songIndex: number,
  track: SpotifyTrack
): Promise<Entry> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(entryId)}/songs/spotify`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      songIndex,
      spotifyUri: track.uri,
      spotifyUrl: track.url,
      name: track.name,
      artist: track.artist,
    }),
  });
  return json<Entry>(res);
}

// --- Logs ---

export interface LogsFilters {
  level?: string;
  entryId?: string;
  /** Comma-separated categories (= the "function" of a log line): `playlist,sync`. */
  category?: string;
  limit?: number;
}

export async function getLogs(filters: LogsFilters = {}): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (filters.level && filters.level !== 'all') params.set('level', filters.level);
  if (filters.entryId) params.set('entryId', filters.entryId);
  if (filters.category) params.set('category', filters.category);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const res = await fetch(url(`/api/logs${qs ? `?${qs}` : ''}`));
  return json<Array<Record<string, unknown>>>(res);
}

export async function clearLogs(): Promise<void> {
  await fetch(url('/api/logs'), { method: 'DELETE' });
}

// --- Admin ---

export interface StoragePlatformCount { platform: string; count: number }
export interface StorageStatusCount { status: string; count: number }
export interface StorageAgeBucket { label: string; count: number }
export interface StorageEntryDirStat {
  entryId: string;
  bytes: number;
  files: number;
  mtime: string;
  orphan: boolean;
}
export interface StorageStats {
  mediaRoot: string;
  totals: { entries: number; mediaDirs: number; mediaFiles: number; mediaBytes: number };
  orphans: { count: number; bytes: number };
  byPlatform: StoragePlatformCount[];
  byStatus: StorageStatusCount[];
  byAge: StorageAgeBucket[];
  topLargest: StorageEntryDirStat[];
}

export async function getAdminStorage(): Promise<StorageStats> {
  const res = await fetch(url('/api/admin/storage'));
  const j = await json<{ success: boolean } & StorageStats>(res);
  return j;
}

export interface PurgeFilter {
  platform?: string | null;
  status?: string | null;
  olderThanDays?: number | null;
  emptyResultsOnly?: boolean;
  dryRun?: boolean;
  confirm?: string;
}

export interface PurgeDryRunResponse {
  success: true;
  dryRun: true;
  wouldDelete: number;
  sampleBytesFreedFromFirst500: number;
  sample: Array<{ id: string; sourceUrl: string; sourcePlatform: string; createdAt: string; status: string }>;
}

export interface PurgeExecuteResponse {
  success: true;
  dryRun: false;
  entriesDeleted: number;
  dirsDeleted: number;
  bytesFreed: number;
}

export async function adminPurge(filter: PurgeFilter): Promise<PurgeDryRunResponse | PurgeExecuteResponse> {
  const res = await fetch(url('/api/admin/purge'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filter),
  });
  return json<PurgeDryRunResponse | PurgeExecuteResponse>(res);
}

export interface RetentionConfig {
  retentionDays: number | null;
  orphanTtlDays: number;
}

export async function getRetention(): Promise<RetentionConfig> {
  const res = await fetch(url('/api/admin/retention'));
  const j = await json<{ success: boolean; config: RetentionConfig }>(res);
  return j.config;
}

export async function updateRetention(updates: Partial<RetentionConfig>): Promise<RetentionConfig> {
  const res = await fetch(url('/api/admin/retention'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const j = await json<{ success: boolean; config: RetentionConfig }>(res);
  return j.config;
}

export interface CleanupResult {
  orphanDirsDeleted: number;
  orphanBytesFreed: number;
  retentionEntriesDeleted: number;
  retentionDirsDeleted: number;
  retentionBytesFreed: number;
}

export async function cleanupOrphans(): Promise<CleanupResult> {
  const res = await fetch(url('/api/admin/cleanup-orphans'), { method: 'POST' });
  const j = await json<{ success: boolean; result: CleanupResult }>(res);
  return j.result;
}

// --- Search ---

export async function searchEntries(q: string, limit = 20): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(url(`/api/search?${params.toString()}`));
  return json<SearchResponse>(res);
}

// --- Films ---

export interface FilmMetaPatchBody {
  watched?: boolean;
  rating?: 'fresh' | 'rotten' | null;
  score?: number | null;
  availability?: Record<string, AvailabilityStatus | null>;
}

export async function fetchFilms(): Promise<AggregatedFilm[]> {
  const res = await fetch(url('/api/films'));
  const data = await json<{ films: AggregatedFilm[] }>(res);
  return data.films;
}

export async function patchFilmMeta(
  filmKey: string,
  patch: FilmMetaPatchBody
): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}

// On-demand refresh of a film's streaming availability data. Throws on any
// non-2xx response (including 503 when no provider is configured) — the
// caller is expected to catch and log, per the pipeline resilience convention.
export async function refreshFilmStreaming(filmKey: string): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}/refresh-streaming`), {
    method: 'POST',
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}

// Manual per-film Internet Archive actions. Both throw on non-2xx (409 when
// the film has no archive file, 502 when Archive itself failed) — the caller
// catches and surfaces it, per the pipeline resilience convention.
export async function archiveLookupFilm(filmKey: string): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}/archive-lookup`), {
    method: 'POST',
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}

export async function archiveDownloadFilm(filmKey: string): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}/archive-download`), {
    method: 'POST',
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}

// --- Songs ---

export interface SongMetaPatchBody {
  listened?: boolean;
  favorite?: boolean;
  downloaded?: boolean;
  rating?: SongRating | null;
  score?: number | null;
}

/**
 * The songs the user knows: the journal's (default), or EVERYTHING (`scope: 'everything'`): the journal's plus the songs that exist
 * only as files (geekom's library, the NAS), flagged `libraryOnly`. The playlist manager asks for everything, so that searching
 * for a song to put in a playlist takes from all the places SoundReel knows (ADR-0018, same rule as «Cerca» in Mondrop).
 */
export async function fetchSongs(scope: 'journal' | 'everything' = 'journal'): Promise<AggregatedSong[]> {
  const res = await fetch(url(scope === 'everything' ? '/api/songs?scope=everything' : '/api/songs'));
  const data = await json<{ songs: AggregatedSong[] }>(res);
  return data.songs;
}

export async function fetchSoftware(): Promise<AggregatedSoftware[]> {
  const res = await fetch(url('/api/software'));
  const data = await json<{ software: AggregatedSoftware[] }>(res);
  return data.software;
}

/**
 * Resolves a playable preview URL right before playback. Always hits the
 * backend rather than trusting a cached client-side value: when the stored
 * URL is Deezer-backed it's a signed URL that expires ~14min after issue,
 * so the backend re-resolves it live on every call; the iTunes-backed case
 * is durable and the backend just returns the stored value. Either way this
 * is one small call per play-press, so there's no need for a client cache.
 * Rejects (via `json()`) on a 404 (no meta / no resolvable source) or any
 * other non-2xx response.
 */
export async function fetchSongPreview(songKey: string): Promise<string> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}/preview`));
  const data = await json<{ url: string }>(res);
  return data.url;
}

export interface SongYoutubeSource {
  videoId: string;
  watchUrl: string;
  source: 'stored_url' | 'yt_search';
}

/** Resolve a playable YouTube video for the web player (online stream). */
export async function fetchSongYoutube(songKey: string): Promise<SongYoutubeSource> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}/youtube`));
  return json<SongYoutubeSource>(res);
}

export interface SongFileInfo {
  inLibrary: boolean;
  relPath: string | null;
  absPath: string | null;
  spootyUrl: string;
}

/** Where the downloaded track lives (music share path) and the Spooty URL,
 * fetched lazily when the inline player panel is opened. */
export async function fetchSongFileInfo(songKey: string): Promise<SongFileInfo> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}/file-info`));
  return json<SongFileInfo>(res);
}

/**
 * First play: ask the server to download the MP3 for a song that has no file yet.
 * `play` jumps the Sync queue (somebody is listening to it right now). Idempotent.
 * Contract: docs/mondrop-sync.md "Primo play".
 */
export async function requestSongDownload(
  songKey: string,
  priority: 'play' | 'sync' = 'play',
): Promise<SongDownloadResponse> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}/download`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority }),
  });
  return json<SongDownloadResponse>(res);
}

/** Server-side file state of one song (ready / preparing / failed / no_source / missing). */
export async function fetchSongState(songKey: string): Promise<SongStateResponse> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}/state`));
  return json<SongStateResponse>(res);
}

/**
 * What to play for a song, decided by the SERVER (rule P, ADR-0018): from the internet the YouTube video, always; at home the
 * file when SoundReel has it, else the video meanwhile (and `download: true`, the server then prepares the file). The browser
 * sends only its preference (the "Sorgente" switch, `prefer`) and follows the answer. Read-only: the download itself is a
 * separate request (`requestSongDownload`). A failure is the caller's to treat as "play the video and ask for nothing".
 * An answer that is not understood is read on the safe side: the video, no file, the external network.
 */
export async function fetchPlayPlan(songKey: string, prefer: PlayPlan['prefer'] = 'auto'): Promise<PlayPlan> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}/play?prefer=${prefer}`), { cache: 'no-store' });
  const raw = await json<Partial<PlayPlan>>(res);
  const file = raw.from === 'media-server' || raw.from === 'disk' ? raw.from : null;
  const fileUrl = file && typeof raw.fileUrl === 'string' && raw.fileUrl ? raw.fileUrl : null;
  return {
    songKey: typeof raw.songKey === 'string' ? raw.songKey : songKey,
    prefer: raw.prefer === 'auto' || raw.prefer === 'internet' || raw.prefer === 'media' ? raw.prefer : prefer,
    network: raw.network === 'internal' ? 'internal' : 'external',
    choice: raw.choice === 'media' ? 'media' : 'internet',
    from: file && fileUrl ? file : 'youtube',
    download: raw.download === true,
    fileUrl,
  };
}

export async function patchSongMeta(
  songKey: string,
  patch: SongMetaPatchBody
): Promise<SongMetaRecord> {
  const res = await fetch(url(`/api/songs/${encodeURIComponent(songKey)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await json<{ meta: SongMetaRecord }>(res);
  return data.meta;
}

// --- Playlists ---

export async function fetchPlaylists(): Promise<PlaylistSummary[]> {
  const res = await fetch(url('/api/playlists'));
  const data = await json<{ playlists: PlaylistSummary[] }>(res);
  return data.playlists;
}

export interface PlaylistPageQuery {
  q?: string;
  filter?: PlaylistFilter;
  sort?: PlaylistSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * The list as the person asks for it (ADR-0023): the SERVER searches, filters, sorts and cuts it in pages, so a long list is never
 * downloaded whole. An old backend that ignores the parameters answers with every playlist and no `total`: the page is then that list.
 */
export async function fetchPlaylistsPage(query: PlaylistPageQuery = {}): Promise<PlaylistPage> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.filter) params.set('filter', query.filter);
  if (query.sort) params.set('sort', query.sort);
  if (query.order) params.set('order', query.order);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const qs = params.toString();
  const res = await fetch(url(`/api/playlists${qs ? `?${qs}` : ''}`));
  const data = await json<{ playlists: PlaylistSummary[]; total?: number; limit?: number | null; offset?: number }>(res);
  return {
    playlists: data.playlists,
    total: data.total ?? data.playlists.length,
    limit: data.limit ?? null,
    offset: data.offset ?? 0,
  };
}

export async function fetchPlaylist(id: string): Promise<PlaylistDetail> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}`));
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

export async function createPlaylist(name: string, songKeys: string[] = []): Promise<PlaylistDetail> {
  const res = await fetch(url('/api/playlists'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, songKeys }),
  });
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

export async function renamePlaylist(id: string, name: string): Promise<PlaylistDetail> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

export async function deletePlaylist(id: string): Promise<void> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}`), { method: 'DELETE' });
  await json<{ ok: boolean }>(res);
}

export async function addSongToPlaylist(id: string, songKey: string): Promise<PlaylistDetail> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}/songs`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songKey }),
  });
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

export async function removeSongFromPlaylist(id: string, songKey: string): Promise<PlaylistDetail> {
  const res = await fetch(
    url(`/api/playlists/${encodeURIComponent(id)}/songs/${encodeURIComponent(songKey)}`),
    { method: 'DELETE' },
  );
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

/** Rewrites the order of a playlist (keys not listed keep their relative order at the end). */
export async function reorderPlaylist(id: string, songKeys: string[]): Promise<PlaylistDetail> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}/songs`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songKeys }),
  });
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

export interface PlaylistSharesResponse {
  playlistId: string;
  sharedWith: string[];
  /** Users the owner can still share with (everybody but the owner). Only on GET. */
  family?: string[];
}

/** Owner only (the backend answers 404 to anybody else). */
export async function fetchPlaylistShares(id: string): Promise<PlaylistSharesResponse & { family: string[] }> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}/shares`));
  return json<PlaylistSharesResponse & { family: string[] }>(res);
}

export async function sharePlaylistWith(id: string, withUsers: string[]): Promise<PlaylistSharesResponse> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}/share`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ with: withUsers }),
  });
  return json<PlaylistSharesResponse>(res);
}

export async function unsharePlaylistWith(id: string, withUser: string): Promise<PlaylistSharesResponse> {
  const params = new URLSearchParams({ with: withUser });
  const res = await fetch(
    url(`/api/playlists/${encodeURIComponent(id)}/share?${params}`),
    { method: 'DELETE' },
  );
  return json<PlaylistSharesResponse>(res);
}

// --- Dynamic playlists (docs/mondrop-stats.md §4) ---

export async function fetchDynamicPresets(): Promise<DynamicPreset[]> {
  const res = await fetch(url('/api/playlists/dynamic/presets'));
  const data = await json<DynamicPreset[] | { presets: DynamicPreset[] }>(res);
  return Array.isArray(data) ? data : (data.presets ?? []);
}

export async function createDynamicPlaylist(name: string, rule: DynamicRule): Promise<PlaylistDetail> {
  const res = await fetch(url('/api/playlists'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, kind: 'dynamic', rule }),
  });
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

/** Edits the RULE of a dynamic playlist (its name cannot change: the backend answers 409 playlist_is_dynamic). */
export async function updatePlaylistRule(id: string, rule: DynamicRule): Promise<PlaylistDetail> {
  const res = await fetch(url(`/api/playlists/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule }),
  });
  const data = await json<{ playlist: PlaylistDetail }>(res);
  return data.playlist;
}

// --- Listening events + statistics (docs/mondrop-stats.md §1, §5) ---

/**
 * Sends a batch of listening events. Resolves with the HTTP status (it does NOT throw on non-2xx): the caller keeps
 * the events until it sees a 200. `keepalive` lets the request outlive the page (visibilitychange / pagehide).
 */
export async function sendPlays(events: PlayEvent[], opts: { keepalive?: boolean } = {}): Promise<number> {
  const res = await fetch(url('/api/plays'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: opts.keepalive === true,
  });
  return res.status;
}

export interface StatsQuery {
  scope: 'me' | 'all';
  from?: string;
  to?: string;
  user?: string;
  device?: string;
  tz?: string;
}

function statsParams(q: StatsQuery): URLSearchParams {
  const params = new URLSearchParams({ scope: q.scope });
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  if (q.user) params.set('user', q.user);
  if (q.device) params.set('device', q.device);
  if (q.tz) params.set('tz', q.tz);
  return params;
}

/** Raw payload: `normalizeStats` (utils/statsView) turns it into a `ListeningStats` whatever fields are missing. */
export async function fetchListeningStats(q: StatsQuery): Promise<unknown> {
  const res = await fetch(url(`/api/stats/listening?${statsParams(q)}`));
  return json<unknown>(res);
}

export async function fetchRecentPlays(q: StatsQuery, limit = 50): Promise<unknown> {
  const params = statsParams(q);
  params.set('limit', String(limit));
  const res = await fetch(url(`/api/stats/listening/recent?${params}`));
  return json<unknown>(res);
}

// --- Notes ---

export async function fetchNotes(): Promise<AggregatedNote[]> {
  const res = await fetch(url('/api/notes'));
  const data = await json<{ notes: AggregatedNote[] }>(res);
  return data.notes;
}

// --- Library search (any signed-in user) ---

/**
 * One search over the journal songs, the whole media server and the local music folders. `limit` is per scope
 * (the server caps it at 100). The server only counts the scopes it searched, so ask for "all" when the three
 * counts matter. Failures keep the server's `{error}` body in the message: see utils/apiError.
 */
export async function searchLibrary(
  q: string,
  scope: LibraryScope = 'all',
  limit = 100,
  signal?: AbortSignal,
): Promise<LibrarySearchResponse> {
  const params = new URLSearchParams({ q, scope, limit: String(limit) });
  const res = await fetch(url(`/api/library/search?${params}`), { signal });
  return json<LibrarySearchResponse>(res);
}

// --- Music folders (admin only: the server answers 403 to everybody else) ---

export async function getMusicFolders(): Promise<MusicFoldersPayload> {
  const res = await fetch(url('/api/config/music-folders'));
  return json<MusicFoldersPayload>(res);
}

/** REPLACES the list of extra folders: send the whole list. The built-in library is never part of it. */
export async function saveMusicFolders(folders: MusicFolderInput[]): Promise<MusicFoldersPayload> {
  const res = await fetch(url('/api/config/music-folders'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folders }),
  });
  return json<MusicFoldersPayload>(res);
}

/** Subfolders of `path` (a container path inside an allowed root); without a path, the allowed roots themselves. */
export async function browseMusicFolders(path?: string | null): Promise<FolderBrowse> {
  const query = path ? `?${new URLSearchParams({ path })}` : '';
  const res = await fetch(url(`/api/config/music-folders/browse${query}`));
  return json<FolderBrowse>(res);
}

/** Ask for a rescan now (the server answers 202 and scans in the background). */
export async function rescanMusicFolders(): Promise<void> {
  const res = await fetch(url('/api/config/music-folders/rescan'), { method: 'POST' });
  if (!res.ok) await json<unknown>(res);
}
