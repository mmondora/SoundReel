import type {
  Entry, SearchResponse, EnrichmentResult, AggregatedFilm, FilmMetaRecord, AvailabilityStatus,
  AggregatedSong, SongMetaRecord, SongRating, AggregatedNote,
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
  return json<AnalyzeResponse>(res);
}

// --- Entries ---

export async function listEntries(limit = 200): Promise<Entry[]> {
  const res = await fetch(url(`/api/entries?limit=${limit}`));
  return json<Entry[]>(res);
}

export async function getEntry(id: string): Promise<Entry> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(id)}`));
  return json<Entry>(res);
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
  limit?: number;
}

export async function getLogs(filters: LogsFilters = {}): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (filters.level && filters.level !== 'all') params.set('level', filters.level);
  if (filters.entryId) params.set('entryId', filters.entryId);
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

// --- Songs ---

export interface SongMetaPatchBody {
  listened?: boolean;
  favorite?: boolean;
  downloaded?: boolean;
  rating?: SongRating | null;
  score?: number | null;
}

export async function fetchSongs(): Promise<AggregatedSong[]> {
  const res = await fetch(url('/api/songs'));
  const data = await json<{ songs: AggregatedSong[] }>(res);
  return data.songs;
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

// --- Notes ---

export async function fetchNotes(): Promise<AggregatedNote[]> {
  const res = await fetch(url('/api/notes'));
  const data = await json<{ notes: AggregatedNote[] }>(res);
  return data.notes;
}
