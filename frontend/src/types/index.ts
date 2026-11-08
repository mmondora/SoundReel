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
  /**
   * The year the song came out, as the providers (Deezer, iTunes) say it; null when none knows it (ADR-0013). The
   * decade ("Anni 80") is derived from it, never stored. Absent from an older backend: read it as "no year".
   */
  releaseYear?: number | null;
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

/** Server-side file state of a song (docs/mondrop-sync.md). */
export type SongFileStateName = 'ready' | 'preparing' | 'failed' | 'no_source' | 'missing';

export interface AggregatedSong {
  songKey: string;
  title: string;
  artist: string;
  album: string | null;
  youtubeUrl: string | null;
  spotifyUrl: string | null;
  mentions: SongMention[];
  meta: SongMetaRecord | null;
  /** True when an MP3 for this song exists under the music library. */
  inLibrary?: boolean;
  /**
   * Optional facets. Newer backends may send them; the playlist manager also derives
   * `platforms` / `tags` client-side from the journal entries when they are absent.
   */
  /** How the song was found (`Song.source` values across the mentions). */
  sources?: Song['source'][];
  /** Platforms of the entries that mention the song (instagram, tiktok, shazam…). */
  platforms?: string[];
  /** Tags of the entries that mention the song. */
  tags?: string[];
  /** Server-side file state, when the backend reports it. */
  fileState?: SongFileStateName;
  /** Where the file is (docs/mondrop-stats.md §6). Absent on an old backend: `inLibrary` then means FS. */
  fs?: boolean;
  mediaServer?: boolean;
  /** Display path of the file on geekom's disk, e.g. "~/Music/SoundReel/X.mp3" (rule W8). */
  fsPath?: string | null;
  /** URL of the file on the media server (rule W8). */
  mediaUrl?: string | null;
}

/** Where a song's file lives: geekom's disk (FS) and/or the media server (MS, the Fritz). Neither = streaming only. */
export interface SongLocation {
  fs: boolean;
  mediaServer: boolean;
}

/**
 * `SongLocation` plus the addresses behind it (rule W8). `streamUrl` is the YouTube watch URL when it is known.
 * Every address is optional: an older backend sends none of them.
 */
export interface SongPlace extends SongLocation {
  fsPath: string | null;
  mediaUrl: string | null;
  streamUrl: string | null;
}

/** What `GET /api/songs/:key/state` sends as `location`: the flags always, the addresses when the backend has them. */
export type SongStateLocation = SongLocation & Partial<Pick<SongPlace, 'fsPath' | 'mediaUrl' | 'streamUrl'>>;

/** `GET /api/net`: where the request comes from, decided by the server (rule W7). */
export type NetworkKind = 'internal' | 'external';
export interface NetworkInfo {
  network: NetworkKind;
}

/** `GET /api/songs/:songKey/state` */
export interface SongStateResponse {
  state: SongFileStateName;
  source: string | null;
  version: string | null;
  bytes: number | null;
  error: string | null;
  inLibrary: boolean;
  location?: SongStateLocation;
}

/** `POST /api/songs/:songKey/download` */
export interface SongDownloadResponse {
  ok: boolean;
  state: SongFileStateName;
  track?: unknown;
}

/** Dynamic playlists (docs/mondrop-stats.md §4): a rule re-evaluated on every request. */
export type DynamicOrder = 'most_played' | 'least_played' | 'recent' | 'never_played';

export interface DynamicRuleWindow {
  /** "HH:MM", the listener's LOCAL time. `from > to` crosses midnight. */
  from: string;
  to: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday; omitted = every day. */
  days?: number[];
}

export interface DynamicRule {
  v: 1;
  scope: 'me' | 'family';
  period: { days: number } | 'all';
  window?: DynamicRuleWindow;
  order: DynamicOrder;
  /** 1–200. */
  limit: number;
  minPlays: number;
  genres?: string[];
  downloadedOnly: boolean;
}

export interface DynamicPreset {
  id: string;
  label: string;
  rule: DynamicRule;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
  /** Authelia user that owns the playlist (only the owner can edit/share it). */
  ownerUser?: string;
  /** Absent on an old backend = static. */
  kind?: 'static' | 'dynamic';
  rule?: DynamicRule | null;
  /** Human-readable rule ("Più ascoltate · 07:00–08:00 · ultimi 30 giorni"). */
  ruleSummary?: string | null;
  /** When the backend last evaluated a dynamic playlist. */
  generatedAt?: string | null;
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
}

export interface AggregatedNote {
  noteKey: string;
  text: string;
  category: NoteCategory;
  mentions: NoteMention[];
  meta: NoteMetaRecord | null;
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
  summary?: string | null;
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
  | 'shazam'
  | 'soundcloud'
  | 'other';

export interface Entry {
  id: string;
  sourceUrl: string;
  sourcePlatform: SocialPlatform;
  inputChannel: 'telegram' | 'web' | 'ios';
  inputUser: string | null;
  /** Authelia username (`mike` / `archi` / `sara`) or `anonymous`. */
  ownerUser?: string;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  status: 'processing' | 'completed' | 'error';
  results: EntryResults;
  actionLog: ActionLogItem[];
  createdAt: string;
}

export interface MeResponse {
  user: string;
  displayName: string;
  isAdmin: boolean;
  authenticated: boolean;
  family: Array<{ id: string; displayName: string }>;
}

export interface JournalStats {
  totalEntries: number;
  totalSongs: number;
  totalFilms: number;
  totalNotes: number;
  totalSoftware?: number;
}

/** Lean entry row for /entries list — no full results/actionLog. */
export interface EntrySummary {
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
  mediaAnalysisEnabled: boolean;
  transcriptionEnabled?: boolean;
  aiAnalysisEnabled?: boolean;
  pageExtractionEnabled?: boolean;
  shazamEnabled?: boolean;
  multiSongScanEnabled?: boolean;
  youtubeDirect?: boolean;
  carouselStructuredExtraction?: boolean;
  outputLanguage?: 'it' | 'en';
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

export interface SearchResult {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  caption: string | null;
  thumbnailUrl: string | null;
  results: {
    songs: Array<{ title: string; artist: string }>;
    films: Array<{ title: string }>;
    notes: Array<{ text: string }>;
    tags: string[];
    summary: string | null;
  };
  createdAt: string;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  expandedTerms: string[];
  total: number;
}

// --- Listening events and statistics (docs/mondrop-stats.md §1, §5) ---

export interface PlayEvent {
  /** Fresh UUID per event: resending it is safe (the server is idempotent). */
  id: string;
  songKey: string;
  /** ISO 8601 UTC: when the song started playing. */
  startedAt: string;
  /** Minutes EAST of UTC at that moment (60 in winter in Italy) = -getTimezoneOffset(). */
  tzOffsetMin: number;
  /** Milliseconds really listened (pauses and seeks do not count). */
  listenedMs: number;
  durationMs: number | null;
  completed: boolean;
  origin: 'web';
  playlistId: string | null;
}

export interface ListeningTotals {
  /** Counted plays (the server decides what counts). */
  plays: number;
  skips: number;
  listenedMs: number;
  songs: number;
  artists: number;
  devices: number;
}

export interface ListeningDay {
  /** YYYY-MM-DD. */
  day: string;
  plays: number;
  listenedMs: number;
}

export interface ListeningRank {
  key: string;
  label: string;
  /** Second line (the artist of a song). */
  sublabel: string | null;
  plays: number;
  listenedMs: number | null;
}

export interface ListeningStats {
  totals: ListeningTotals;
  perDay: ListeningDay[];
  /** 7 rows (Monday = 0) × 24 hours (the listener's local hour). */
  heatmap: number[][];
  topSongs: ListeningRank[];
  topArtists: ListeningRank[];
  topGenres: ListeningRank[];
  perDevice: ListeningRank[];
  perOrigin: ListeningRank[];
  neverPlayed: number;
  period: { from: string | null; to: string | null };
}

export interface RecentPlay {
  id: string;
  songKey: string;
  title: string;
  artist: string;
  user: string | null;
  device: string | null;
  origin: string | null;
  startedAt: string;
  listenedMs: number;
  counted: boolean | null;
}

// --- Library search over three scopes, and the music folders it reads (spec 2026-11-07-library-search-music-folders) ---

export type LibraryScope = 'all' | 'songs' | 'media' | 'local';
export type LibraryHitScope = Exclude<LibraryScope, 'all'>;

/** One match: information about where a file is (finding it never imports or plays it, rule L6). */
export interface LibraryHit {
  scope: LibraryHitScope;
  artist: string;
  title: string;
  album: string | null;
  /** "Libreria", "Media server", or the label of the local folder. */
  folder: string;
  /** URL on the media server, or path on disk ("~/Music/…"); null for a journal song. */
  location: string | null;
  bytes: number | null;
  songKey: string;
  /** The song is already in the journal (so it already shows in the Songs page). */
  inJournal: boolean;
}

/** Matches per scope BEFORE the limit. The backend only counts the scopes it searched. */
export interface LibrarySearchCounts {
  songs: number;
  media: number;
  local: number;
}

export interface LibrarySearchResponse {
  q: string;
  scope: LibraryScope;
  counts: LibrarySearchCounts;
  results: LibraryHit[];
}

export type MusicFolderStatus = 'ok' | 'scanning' | 'pending' | 'missing' | 'off';

/** A place the backend may read music from (the folders mounted in the container). */
export interface MusicFolderRoot {
  path: string;
  label: string;
  builtIn: boolean;
}

export interface MusicFolder {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  /** The library of Spooty (`/music`): always searched, never editable. */
  builtIn: boolean;
  status: MusicFolderStatus;
  files: number;
  /** The scan hit the file limit: there are more files than the index holds. */
  truncated: boolean;
  scannedAt: string | null;
}

export interface MusicFoldersPayload {
  roots: MusicFolderRoot[];
  folders: MusicFolder[];
}

/** What is sent to replace the list of extra folders. */
export interface MusicFolderInput {
  path: string;
  label?: string;
  enabled?: boolean;
}

/** `GET /api/config/music-folders/browse`: the subfolders of an allowed place (no path = the allowed roots). */
export interface FolderBrowse {
  path: string | null;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
}
