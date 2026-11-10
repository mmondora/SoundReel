export interface Song {
  title: string;
  artist: string;
  album: string | null;
  source: 'audio_fingerprint' | 'ai_analysis' | 'both' | 'music_list' | 'spotify_link' | 'shazam_link';
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

/** Professional software / docs references extracted from posts. */
export type SoftwareTag = 'repo' | 'product' | 'article' | 'other';

export interface SoftwareItem {
  title: string;
  url: string | null;
  tag: SoftwareTag;
  description?: string | null;
}

export interface SoftwareMention {
  entryId: string;
  createdAt: string;
  /** The original post (spec no-duplicates-and-post-links, D3). */
  sourceUrl?: string | null;
  sourcePlatform?: string | null;
}

export interface SoftwareMetaRecord {
  softwareKey: string;
  description: string | null;
  /** Repo creation date from the forge API (GitHub/GitLab/Codeberg created_at). */
  publishedAt: string | null;
  host: string | null;
  enrichedAt: string | null;
}

export interface AggregatedSoftware {
  softwareKey: string;
  title: string;
  url: string | null;
  tag: SoftwareTag;
  description: string | null;
  /** Repo creation date when known from forge enrichment. */
  publishedAt?: string | null;
  mentions: SoftwareMention[];
  /** Other links of the same software (spec D4): the main `url` is a verified repository, else the official site. */
  otherUrls?: string[];
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
  software?: SoftwareItem[];
  links: ExtractedLink[];
  tags: string[];
  summary: string | null;
  transcript?: string | null;
  transcriptLanguage?: string | null;
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
  | 'shazam'
  | 'soundcloud'
  | 'other';

export interface Entry {
  id: string;
  sourceUrl: string;
  sourcePlatform: SocialPlatform;
  inputChannel: 'telegram' | 'web' | 'ios';
  inputUser: string | null;
  /** Authelia username that owns this entry (`mike` / `archi` / `sara`). */
  ownerUser: string;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: string;
}

/** Lean list row for Entries page — no full results/actionLog payload. */
export interface EntrySummaryRow {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  caption: string | null;
  thumbnailUrl: string | null;
  status: string;
  createdAt: string;
  summary: string | null;
  songCount: number;
  filmCount: number;
  noteCount: number;
  tags: string[];
}

export interface JournalStats {
  totalEntries: number;
  totalSongs: number;
  totalFilms: number;
  totalNotes: number;
  totalSoftware: number;
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
  /**
   * A written track the source already carried (YouTube captions), when one
   * existed. Preferred over Whisper: instant, free, and it never touches the
   * GPU. `subtitleKind` says whether a person wrote it or a machine did.
   */
  subtitleText?: string | null;
  subtitleLang?: string | null;
  subtitleKind?: string | null;
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
  software?: SoftwareItem[];
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
  /** The original post (spec no-duplicates-and-post-links, D3). */
  sourceUrl?: string | null;
  sourcePlatform?: string | null;
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
  /** Release year from the provider's date (ADR-0013); null = unknown ("Senza anno" in the filters). */
  releaseYear: number | null;
  coverUrl: string | null;
  previewUrl: string | null;
  deezerUrl: string | null;
  itunesUrl: string | null;
  enrichedAt: string | null;
}

export interface SongMention {
  entryId: string;
  createdAt: string;
  /** The original post (spec no-duplicates-and-post-links, D3). */
  sourceUrl?: string | null;
  sourcePlatform?: string | null;
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
  /** The green dot: exactly `fs || mediaServer` (an MP3 on geekom's disk or on the media server). */
  inLibrary: boolean;
  /** An MP3 on geekom's disk (Spooty's library or our store). */
  fs?: boolean;
  /** An MP3 on the media server (the box's own file, a verified replica, or a catalogue entry). */
  mediaServer?: boolean;
  /** Where the disk file is (display path, `~/Music/…`), or null. */
  fsPath?: string | null;
  /** Direct URL of the file on the media server, or null. */
  mediaUrl?: string | null;
  /** How the song was found, across its mentions (`Song.source` values), sorted. */
  sources?: string[];
  /** Platforms of the entries that mention it (instagram, shazam, spotify…), sorted. */
  platforms?: string[];
  /** Tags of the entries that mention it, sorted. */
  tags?: string[];
  /** Set when the title says this song is a version of another one (spec no-duplicates-and-post-links §7, D5). */
  versionOf?: SongVersionOf;
  /**
   * True for a song that exists only as a FILE (geekom's library or the box), never saved from a post (ADR-0018). It has
   * no mentions and no metadata; the server serves it if its file exists and never downloads it from YouTube.
   */
  libraryOnly?: boolean;
}

/**
 * "Versione di …": this song is its own card but is a version (Instrumental, Slowed + Reverb, Live, a Remix…) of another
 * song, or a credit or remaster spelling of it. Computed at read time from the titles: the song key is unchanged.
 */
export interface SongVersionOf {
  /** The title of the original (the card's own title when the journal has it, else the title without its markers). */
  title: string;
  artist: string | null;
  /** The key of the original's card, or null when the journal has none (or more than one possible). */
  songKey: string | null;
  /** The markers as written: "Slowed + Reverb", "feat. Pusha T", "2008 Remaster". */
  labels: string[];
}

export interface PlaylistSummary {
  id: string;
  name: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
  /** `dynamic` = a rule evaluated at read time (ADR-0008); absent / `static` = a list of songs. */
  kind?: 'static' | 'dynamic';
  rule?: import('../services/dynamicRules').DynamicRule;
  ruleSummary?: string;
  /** When a dynamic playlist's songs were last computed. */
  generatedAt?: string;
  /** `auto` = made by the server from a post that talks about music (ADR-0023); absent / `user` = made by hand. */
  origin?: 'user' | 'auto';
  /** How an automatic playlist was made: one for a post (`one_off`) or one for a generic theme (`theme`). */
  autoKind?: 'one_off' | 'theme' | null;
}

export interface PlaylistDetail extends PlaylistSummary {
  songKeys: string[];
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
  /** The original post (spec no-duplicates-and-post-links, D3). */
  sourceUrl?: string | null;
  sourcePlatform?: string | null;
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
