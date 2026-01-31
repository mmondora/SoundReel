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
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: FirebaseFirestore.FieldValue | string;
}

export interface ExtractedContent {
  caption: string | null;
  thumbnailUrl: string | null;
  audioUrl: string | null;
  hasAudio: boolean;
  hasCaption: boolean;
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

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  playlistId: string | null;
}
