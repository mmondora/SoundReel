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
  summary: string | null;
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
  id?: string;
  sourceUrl: string;
  sourcePlatform: SocialPlatform;
  inputChannel: 'telegram' | 'web';
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: FirebaseFirestore.FieldValue | string;
}

export interface MusicMetadata {
  title: string;
  artist: string;
}

export interface ExtractedContent {
  caption: string | null;
  thumbnailUrl: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  hasAudio: boolean;
  hasCaption: boolean;
  musicInfo: MusicMetadata | null;
}

export interface AiAnalysisResult {
  songs: Array<{
    title: string;
    artist: string;
    album: string | null;
  }>;
  films: Array<{
    title: string;
    director: string | null;
    year: string | null;
  }>;
  notes: Note[];
  links: ExtractedLink[];
  tags: string[];
  summary: string | null;
}

export interface MediaAiAnalysisResult extends AiAnalysisResult {
  transcription: string | null;
  visualContext: string | null;
  overlayText: string | null;
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
}

export interface AudioRecognitionResult {
  title: string;
  artist: string;
  album: string | null;
}

export interface SpotifySearchResult {
  uri: string;
  url: string;
  name: string;
  artist: string;
}

export interface TmdbSearchResult {
  id: number;
  title: string;
  imdbId: string | null;
  posterPath: string | null;
  releaseDate: string | null;
}

export interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  estimatedCostUSD: number;
}

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  playlistId: string | null;
}
