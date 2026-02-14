export interface Song {
  title: string;
  artist: string;
  album: string | null;
  source: 'audio_fingerprint' | 'ai_analysis' | 'both';
  spotifyUri: string | null;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  soundcloudUrl: string | null;
  addedToPlaylist: boolean;
}

export interface StreamingUrls {
  netflix: string;
  primeVideo: string;
  raiPlay: string;
  now: string;
  disneyPlus: string;
  appleTv: string;
}

export interface Film {
  title: string;
  director: string | null;
  year: string | null;
  imdbUrl: string | null;
  posterUrl: string | null;
  streamingUrls: StreamingUrls | null;
}

export interface ActionLogItem {
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface Note {
  text: string;
  category: 'place' | 'event' | 'brand' | 'book' | 'product' | 'quote' | 'person' | 'other';
}

export interface ExtractedLink {
  url: string;
  label: string | null;
}

export interface EnrichmentLink {
  url: string;
  title: string;
  snippet: string;
}

export interface EnrichmentItem {
  label: string;
  links: EnrichmentLink[];
}

export interface EntryResults {
  songs: Song[];
  films: Film[];
  notes: Note[];
  links: ExtractedLink[];
  tags: string[];
  summary?: string | null;
  transcript?: string | null;
  enrichments?: EnrichmentItem[];
  transcription?: string | null;
  visualContext?: string | null;
  overlayText?: string | null;
}

export type SocialPlatform =
  | 'instagram'
  | 'tiktok'
  | 'youtube'
  | 'facebook'
  | 'twitter'
  | 'threads'
  | 'snapchat'
  | 'pinterest'
  | 'linkedin'
  | 'reddit'
  | 'vimeo'
  | 'twitch'
  | 'spotify'
  | 'soundcloud'
  | 'other';

export interface Entry {
  id: string;
  sourceUrl: string;
  sourcePlatform: SocialPlatform;
  inputChannel: 'telegram' | 'web';
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: string;
}

export interface JournalStats {
  totalEntries: number;
  totalSongs: number;
  totalFilms: number;
  totalNotes: number;
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
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
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
  enrichment: PromptTemplate;
  mediaAnalysis: PromptTemplate;
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
