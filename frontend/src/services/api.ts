import type { Entry } from '../types';

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

export async function enrichEntry(entryId: string): Promise<{ success: boolean; enrichments: unknown[] }> {
  const res = await fetch(url('/api/entries/enrich'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });
  return json<{ success: boolean; enrichments: unknown[] }>(res);
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
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
  useVertexAi: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
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

export async function getSpotifyStatus(): Promise<SpotifyStatus> {
  const res = await fetch(url('/api/spotify/status'));
  return json<SpotifyStatus>(res);
}

export function spotifyAuthorizeUrl(): string {
  return url('/api/spotify/authorize');
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
