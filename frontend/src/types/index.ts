export interface Song {
  title: string;
  artist: string;
  album: string | null;
  source: 'audio_fingerprint' | 'ai_analysis' | 'both';
  spotifyUri: string | null;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  addedToPlaylist: boolean;
}

export interface Film {
  title: string;
  director: string | null;
  year: string | null;
  imdbUrl: string | null;
  posterUrl: string | null;
}

export interface ActionLogItem {
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface EntryResults {
  songs: Song[];
  films: Film[];
}

export interface Entry {
  id: string;
  sourceUrl: string;
  sourcePlatform: 'instagram' | 'tiktok' | 'other';
  inputChannel: 'telegram' | 'web';
  caption: string | null;
  thumbnailUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: string;
}

export interface JournalStats {
  totalEntries: number;
  totalSongs: number;
  totalFilms: number;
}

export interface SpotifyConfig {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  playlistId: string | null;
  playlistName: string | null;
  connected: boolean;
}

export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
}

export interface PromptTemplate {
  name: string;
  description: string;
  template: string;
  variables: string[];
  updatedAt: string;
}

export interface PromptsConfig {
  contentAnalysis: PromptTemplate;
  telegramResponse: PromptTemplate;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  function: string;
  message: string;
  data: Record<string, unknown> | null;
  entryId: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface LogFilters {
  level: LogLevel | 'all';
  function: string | 'all';
  entryId: string | null;
  search: string;
}
