export interface Song {
  title: string;
  artist: string;
  album: string | null;
  source: 'audio_fingerprint' | 'ai_analysis' | 'both' | 'music_list';
  spotifyUri: string | null;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  soundcloudUrl: string | null;
  addedToPlaylist: boolean;
  sourceSlide?: number;
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
  sourceSlide?: number;
}

export interface ActionLogItem {
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export type NoteCategory =
  | 'place' | 'event' | 'brand' | 'book' | 'product' | 'quote' | 'person' | 'other';

export interface Note {
  text: string;
  category: NoteCategory;
}

export type ExtractedLinkCategory =
  | 'referenced'
  | 'sponsor'
  | 'navigation'
  | 'related'
  | 'social'
  | 'other';

export interface ExtractedLink {
  url: string;
  label: string | null;
  domain?: string | null;
  faviconUrl?: string | null;
  title?: string | null;
  category?: ExtractedLinkCategory | null;
}

export type EnrichmentCategory = 'tech' | 'security' | 'claim' | 'generic';

export type EnrichmentVerdictLabel =
  | 'vero' | 'falso' | 'dubbio' | 'ai-generated' | 'phishing' | 'sicuro' | 'sospetto';

export interface EnrichmentVerdict {
  label: EnrichmentVerdictLabel;
  confidence: number;
  explanation: string;
}

export interface EnrichmentLink {
  url: string;
  title: string;
  snippet: string;
}

export interface EnrichmentItem {
  label: string;
  explanation: string;
  links: EnrichmentLink[];
}

export interface EnrichmentResult {
  category: EnrichmentCategory;
  verdict?: EnrichmentVerdict;
  items: EnrichmentItem[];
}

export interface SlideLink {
  url: string;
  label: string;
}

export interface EntrySlide {
  /** 0-based position in the carousel. */
  index: number;
  /** Servable path under /media/<entryId>/, or null when the file is gone. */
  imageUrl: string | null;
  /** OCR text for this slide alone. */
  ocrText: string | null;
  /** Vision description — only for slides carrying little or no OCR text. */
  visualDescription: string | null;
  /** The model's paragraph explaining this slide. */
  summary: string | null;
  /** Model-suggested destinations for what this slide is about. */
  links: SlideLink[];
}

export interface EntryResults {
  songs: Song[];
  films: Film[];
  notes: Note[];
  links: ExtractedLink[];
  tags: string[];
  summary: string | null;
  transcript?: string | null;
  enrichments?: EnrichmentResult;
  slides?: EntrySlide[];
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
  inputChannel: 'telegram' | 'web' | 'ios';
  inputUser: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: string;
}

export interface MusicMetadata {
  title: string;
  artist: string;
}

export interface ExtractedContentLocalPaths {
  videoPath: string | null;
  audioPath: string | null;
  thumbnailPath: string | null;
  slidePaths: string[];
  framePaths: string[];
}

export interface ExtractedContent {
  caption: string | null;
  thumbnailUrl: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  hasAudio: boolean;
  hasCaption: boolean;
  musicInfo: MusicMetadata | null;
  carouselUrls: string[];
  localPaths?: ExtractedContentLocalPaths;
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
  genres: string[];
  overview: string | null;
  cast: string[];
  voteAverage: number | null;
}

export type AvailabilityStatus = 'free' | 'paid' | 'absent';

export type StreamingOptionType = 'FREE' | 'SUBSCRIPTION' | 'RENTAL' | 'PURCHASE';

export interface StreamingPlatformOption {
  platform: string;
  type: StreamingOptionType;
  is_free: boolean;
  price: number | null;
  url: string;
}

export interface FilmUserMeta {
  watched: boolean;
  rating: 'fresh' | 'rotten' | null;
  score: number | null;
  availability: Partial<Record<keyof StreamingUrls, AvailabilityStatus>>;
}

export interface FilmMetaRecord extends FilmUserMeta {
  filmKey: string;
  tmdbId: number | null;
  genres: string[];
  overview: string | null;
  cast: string[];
  tmdbScore: number | null;
  streamingOptions: StreamingPlatformOption[] | null;
  streamingCheckedAt: string | null;
  watchmodeTitleId: number | null;
  iaIdentifier: string | null;
  iaTitle: string | null;
  iaYear: string | null;
  iaPageUrl: string | null;
  iaFileUrl: string | null;
  iaCheckedAt: string | null;
  iaDownloadedPath: string | null;
}

export interface FilmMention {
  entryId: string;
  createdAt: string;
}

export interface AggregatedFilm {
  filmKey: string;
  title: string;
  director: string | null;
  year: string | null;
  imdbUrl: string | null;
  posterUrl: string | null;
  streamingUrls: StreamingUrls | null;
  mentions: FilmMention[];
  meta: FilmMetaRecord | null;
}

export type SongRating = 'like' | 'dislike';

export interface SongUserMeta {
  listened: boolean;
  favorite: boolean;
  downloaded: boolean;
  rating: SongRating | null;
  score: number | null;
}

export interface SongMetaRecord extends SongUserMeta {
  songKey: string;
  deezerId: number | null;
  itunesId: number | null;
  genres: string[];
  album: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  deezerUrl: string | null;
  itunesUrl: string | null;
  enrichedAt: string | null;
}

export interface SongMention {
  entryId: string;
  createdAt: string;
}

export interface AggregatedSong {
  songKey: string;
  title: string;
  artist: string;
  album: string | null;
  youtubeUrl: string | null;
  spotifyUrl: string | null;
  mentions: SongMention[];
  meta: SongMetaRecord | null;
}

export interface NoteMetaRecord {
  noteKey: string;
  bookTitle: string | null;
  bookAuthor: string | null;
  bookYear: number | null;
  coverUrl: string | null;
  openlibraryUrl: string | null;
  placeName: string | null;
  placeDisplayName: string | null;
  placeLat: number | null;
  placeLon: number | null;
  osmUrl: string | null;
  enrichedAt: string | null;
}

export interface NoteMention {
  entryId: string;
  createdAt: string;
}

export interface AggregatedNote {
  noteKey: string;
  text: string;
  category: NoteCategory;
  mentions: NoteMention[];
  meta: NoteMetaRecord | null;
}

export interface AiUsageMetadata {
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
