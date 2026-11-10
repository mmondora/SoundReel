export type Language = 'it' | 'en';

export interface Translations {
  // Header
  entries: string;
  songs: string;
  films: string;
  notes: string;
  software: string;
  navInbox: string;
  navLinks: string;
  navKbLabel: string;
  // the shell: top bar, left menu, player bar (look and feel, spec 2026-11-10-web-look-and-feel-rethink-design.md)
  shellNavLabel: string;
  shellGroupArchive: string;
  shellGroupListen: string;
  shellPaste: string;
  shellClearSearch: string;
  shellMore: string;
  shellPlayerLabel: string;
  // the views of a page (Home, Studio, Bacheca) and the detail that closes (look and feel, phase P3)
  viewSwitchLabel: string;
  viewHome: string;
  viewStudio: string;
  viewWall: string;
  prefsSaveError: string;
  /** The «×» of a message that can be dismissed. */
  dismiss: string;
  detailClose: string;
  /** The name of the panel that shows a post next to the wall. */
  detailLabel: string;
  wallLabel: string;
  /** «+{count} brani» under the first songs of a post on the wall. */
  wallMoreSongs: string;
  wallMoreFilms: string;
  // the Home view: the sections the server prepares and the user orders (docs/web-home.md, docs/ui-prefs.md)
  homeSectionResume: string;
  homeSectionSongs: string;
  homeSectionPlaylists: string;
  homeSectionCollections: string;
  homeSectionFilms: string;
  /** «Vedi tutto (N)» at the head of a section. */
  homeSeeAll: string;
  homeLoadError: string;
  homeEmpty: string;
  shellPlay: string;
  shellPause: string;
  shellNext: string;
  shellPrevious: string;
  shellSeek: string;
  shellNothingPlaying: string;
  shellOpenPlayer: string;
  navSearchPlaceholder: string;
  libraryNav: string;
  libraryTitle: string;
  libraryHint: string;
  libraryEmpty: string;
  localMediaSection: string;
  localMediaBadge: string;
  framePrev: string;
  frameNext: string;
  deleteAll: string;
  deleting: string;
  console: string;
  aiPrompts: string;
  settings: string;

  // Home
  inputPlaceholder: string;
  analyze: string;
  analyzing: string;
  analyzeHeroTitle: string;
  analyzeHeroSub: string;
  analyzeHeroPlatforms: string;
  urlAlreadyAnalyzed: string;
  analysisComplete: string;
  loadMoreEntries: string;
  entriesCountLabel: string;

  // Journal
  loading: string;
  noEntries: string;
  noEntriesHint: string;
  processing: string;
  error: string;
  noContentFound: string;

  // Entry Card
  songsSection: string;
  filmsSection: string;
  deleteEntry: string;
  confirmDelete: string;
  deleteError: string;
  showLog: string;
  hideLog: string;

  // Caption toggle & Summary
  showMore: string;
  showLess: string;
  summarySection: string;

  // Notes, Links, Tags
  notesSection: string;
  linksSection: string;
  tagsSection: string;
  notePlace: string;
  noteEvent: string;
  noteBrand: string;
  noteBook: string;
  noteProduct: string;
  noteQuote: string;
  notePerson: string;
  noteOther: string;

  // Song/Film Items
  addedToPlaylist: string;
  openOnSpotify: string;
  searchOnYoutube: string;
  searchOnSoundcloud: string;
  searchOnSpotify: string;
  addToPlaylistBtn: string;
  addingToPlaylist: string;
  noSpotifyResults: string;
  spotifyNotConnected: string;
  openOnIMDb: string;
  searchOnNetflix: string;
  searchOnPrimeVideo: string;
  searchOnRaiPlay: string;
  searchOnNow: string;
  searchOnDisneyPlus: string;
  searchOnAppleTv: string;
  buyOnAmazon: string;
  searchOnGoogleBooks: string;
  by: string;
  director: string;
  year: string;

  // Settings
  settingsTitle: string;
  backToJournal: string;
  spotify: string;
  spotifyConnected: string;
  spotifyDisconnected: string;
  spotifyHint: string;
  connectSpotify: string;
  connecting: string;
  playlist: string;

  // Features
  allowDuplicates: string;
  allowDuplicatesDescription: string;
  shazamTitle: string;
  shazamDescription: string;
  multiSongTitle: string;
  multiSongDescription: string;
  youtubeDirectTitle: string;
  youtubeDirectDescription: string;
  carouselExtractionTitle: string;
  carouselExtractionDescription: string;

  // Language
  language: string;
  languageDescription: string;
  italian: string;
  english: string;

  // Console
  debugConsole: string;
  home: string;
  logs: string;
  live: string;
  clearLogs: string;
  confirmClearLogs: string;
  noLogsFound: string;
  loadingLogs: string;
  level: string;
  function: string;
  search: string;
  all: string;
  data: string;
  errorLabel: string;

  // Prompts
  promptsTitle: string;
  contentAnalysis: string;
  telegramResponse: string;
  enrichmentPrompt: string;
  variables: string;
  availableVariables: string;
  promptName: string;
  promptDescription: string;
  save: string;
  saving: string;
  reset: string;
  resetDefault: string;
  resetConfirm: string;
  lastUpdated: string;
  promptSaved: string;
  promptReset: string;
  templateError: string;
  templateValid: string;
  loadError: string;
  saveError: string;
  resetError: string;

  // Console additional
  entryId: string;
  allLevels: string;
  allFunctions: string;
  logsActivity: string;
  logsActor: string;
  searchLogs: string;
  clearLogsError: string;

  // OpenAI Enrichment
  openaiSection: string;
  openaiDescription: string;
  openaiApiKey: string;
  openaiSaveSuccess: string;
  openaiSaveError: string;
  openaiHowTo: string;

  // Retry & Enrich
  retryEntry: string;
  retrying: string;
  enrichEntry: string;
  enriching: string;
  enrichmentsSection: string;
  enrichError: string;
  retryError: string;

  // Media Analysis & Auto-enrich
  transcription: string;
  visualContext: string;
  overlayText: string;
  mediaAnalysis: string;
  mediaAnalysisDescription: string;
  mediaAnalysisPrompt: string;
  pipelineFeatures: string;
  pageExtractionTitle: string;
  pageExtractionDescription: string;

  aiAnalysisToggle: string;
  aiAnalysisToggleDescription: string;
  transcriptionToggle: string;
  transcriptionToggleDescription: string;

  // Inspector
  selectEntry: string;
  selectEntryHint: string;
  openOriginal: string;
  copyUrl: string;
  urlCopied: string;
  shareEntry: string;
  transcript: string;
  deepSearch: string;
  runDeepSearch: string;
  timeAgo: string;
  justNow: string;
  minutesAgo: string;
  hoursAgo: string;
  yesterday: string;
  daysAgo: string;
  back: string;

  // Danger Zone
  dangerZone: string;
  mfTitle: string;
  mfIntro: string;
  mfBuiltIn: string;
  mfBuiltInNote: string;
  mfRoots: string;
  mfMountNote: string;
  mfNoExtra: string;
  mfAdd: string;
  mfRescan: string;
  mfLabelOf: string;
  mfSwitchOf: string;
  mfRemove: string;
  mfRemoveOf: string;
  mfRemoveHint: string;
  mfStatusOk: string;
  mfStatusScanning: string;
  mfStatusPending: string;
  mfStatusMissing: string;
  mfStatusOff: string;
  mfFiles: string;
  mfFileOne: string;
  mfTruncated: string;
  mfScannedAt: string;
  mfNeverScanned: string;
  mfSaving: string;
  mfLoading: string;
  mfLoadError: string;
  mfRetry: string;
  mfPickerTitle: string;
  mfPickerRoots: string;
  mfPickerCurrent: string;
  mfPickerHere: string;
  mfPickerUp: string;
  mfPickerOpen: string;
  mfPickerAdd: string;
  mfPickerEmpty: string;
  mfPickerNoRoots: string;
  mfPickerLoading: string;
  mfErrOutside: string;
  mfErrMissing: string;
  mfErrNotDir: string;
  mfErrIncluded: string;
  mfErrTooMany: string;
  mfErrInvalid: string;
  mfErrForbidden: string;
  mfErrNetwork: string;
  mfErrUnknown: string;
  mfErrAt: string;
  deleteAllDescription: string;

  // Errors
  errorGeneric: string;
  errorAnalysis: string;
  errorDelete: string;
  errorSettings: string;

  // Confirmations
  confirmDeleteAll: string;
  deleted: string;

  // Recent section
  recentEntries: string;
  /** Inbox First: ghost control that reveals the chip filter bar. */
  filterToggle: string;
  /** Inbox First: link under the recent slice to the full journal. */
  seeAllJournal: string;
  /** Inbox First: empty inspector prompt under the main hint. */
  inboxEmptyHint: string;

  // Pagination & List Pages
  previousPage: string;
  nextPage: string;
  pageOf: string;
  allEntries: string;
  allSongs: string;
  allFilms: string;
  allNotes: string;
  allSoftware: string;
  noSoftwareYet: string;
  softwareTagSection: string;
  softwareTagRepo: string;
  softwareTagProduct: string;
  softwareTagArticle: string;
  softwareTagOther: string;
  softwareOpenLink: string;
  softwarePublished: string;
  sortByTitle: string;
  viewReel: string;
  sortRecent: string;
  sortArtist: string;
  sortTitle: string;
  sortFrequency: string;
  unknownArtist: string;
  slidesSection: string;
  slideCounter: string;
  slideSuggestedLinks: string;
  slideOcrText: string;
  openEntry: string;
  today: string;
  noSongsYet: string;
  libScopeLabel: string;
  libScopeSongs: string;
  libScopeMedia: string;
  libScopeLocal: string;
  libScopeAll: string;
  libScopeTitle: string;
  libMinChars: string;
  libSearching: string;
  libResultsLabel: string;
  libSummaryAll: string;
  libSummaryOne: string;
  libSummarySingle: string;
  libNone: string;
  libElsewhere: string;
  libNoSongsHere: string;
  libShownOf: string;
  libInfoOnly: string;
  libInJournal: string;
  libInJournalTitle: string;
  libCopyPath: string;
  libCopyUrl: string;
  libErrForbidden: string;
  libErrNetwork: string;
  libErrServer: string;
  libErrInvalid: string;
  libRetry: string;
  noFilmsYet: string;
  noNotesYet: string;

  // Compact filter bar & panel (shared by Films/Songs pages)
  searchPlaceholder: string;
  filtersButton: string;
  filtersReset: string;
  filtersTitle: string;
  genreSectionLabel: string;
  sortLabel: string;
  sortByDate: string;
  sortByMentions: string;
  sortByDirector: string;
  sortByArtist: string;

  // Films page filters & ratings
  filmsFilterAll: string;
  filmsFilterWatched: string;
  filmsFilterUnwatched: string;
  filmsFilterFree: string;
  filmsFilterNotFree: string;
  filmsShelfLabel: string;
  filmsShelfNetflix: string;
  filmsShelfPrime: string;
  filmsShelfRaiPlay: string;
  filmsOpenOnPlatform: string;
  filmsMentions: string;
  filmsMarkFresh: string;
  filmsMarkRotten: string;
  filmsMarkWatched: string;
  filmsScorePlaceholder: string;
  filmsAvailabilityHint: string;
  licensesTitle: string;
  licensesDataProviders: string;
  licensesOssTitle: string;
  licensesPackage: string;
  licensesVersion: string;
  licensesLicense: string;
  licensesLink: string;
  filmsWatchedFilterLabel: string;
  filmsAvailabilityFilterLabel: string;
  filmsTmdbScore: string;
  filmsRefreshStreaming: string;
  filmsStreamFree: string;
  filmsStreamSub: string;
  filmsStreamRent: string;
  filmsStreamBuy: string;
  filmsArchiveBadge: string;
  filmsArchiveLookup: string;
  filmsArchiveDownload: string;
  filmsArchiveDownloaded: string;
  filmsArchiveNone: string;

  // Songs page filters & ratings
  songsFilterListened: string;
  songsFilterUnlistened: string;
  songsFilterFavorites: string;
  songsFilterDownloaded: string;
  songsFilterNotDownloaded: string;
  songsListenedFilterLabel: string;
  songsDownloadedFilterLabel: string;
  songsMarkLike: string;
  songsMarkDislike: string;
  songsMarkListened: string;
  songsMarkFavorite: string;
  songsMarkDownloaded: string;
  songsDownloadedLink: string;
  songsDownloadFile: string;
  songsOpenSpooty: string;
  songsFileMissing: string;
  songsPreview: string;
  songsMentions: string;
  fromPost: string;
  versionOf: string;
  softwareOtherLinks: string;
  playerNav: string;
  playerTitle: string;
  playerOpen: string;
  playerEmpty: string;
  playerEmptyHint: string;
  playerFilterAll: string;
  playerFilterLiked: string;
  playerPreviewOnly: string;
  playerShuffle: string;
  playerRepeatOff: string;
  playerRepeatAll: string;
  playerRepeatOne: string;
  playerNowPlaying: string;
  playerQueue: string;
  playerBrowseHint: string;
  playlistsTitle: string;
  playlistCreate: string;
  playlistCreateNew: string;
  playlistNamePlaceholder: string;
  playlistEmpty: string;
  playlistShowAll: string;
  playlistAddHint: string;
  playlistAddSong: string;
  playlistRemoveSong: string;
  playlistRename: string;
  playlistDelete: string;
  playlistDeleteConfirm: string;
  playlistSave: string;
  playlistCancel: string;
  playlistError: string;
  // The list of playlists: search, show, sort by date, pages (ADR-0023)
  playlistSearchPlaceholder: string;
  playlistFilterLabel: string;
  playlistFilterAll: string;
  playlistFilterAuto: string;
  playlistFilterMine: string;
  playlistFilterShared: string;
  playlistFilterDynamic: string;
  playlistSortLabel: string;
  playlistSortCreated: string;
  playlistSortUpdated: string;
  playlistSortName: string;
  playlistSortSize: string;
  playlistOrderDesc: string;
  playlistOrderAsc: string;
  playlistShowMore: string;
  playlistShownOf: string;
  playlistAutoBadge: string;
  /** The Songs page folds the list of playlists into one line (tooltip of the toggle). */
  playlistPanelShow: string;
  playlistPanelHide: string;
  playlistNoMatch: string;
  playlistPlay: string;
  playlistActiveChip: string;

  // Playlist manager (Norton Commander) + first-play download chip
  mgrTitle: string;
  mgrHint: string;
  mgrLibrary: string;
  mgrFileOnly: string;
  playerShowing: string;
  playerShowMore: string;
  mgrFileOnlyHint: string;
  mgrShowMore: string;
  mgrShowing: string;
  mgrMine: string;
  mgrSharedWithMe: string;
  mgrPaneA: string;
  mgrPaneB: string;
  mgrPanes: string;
  mgrLocationLabel: string;
  mgrReload: string;
  mgrLoadError: string;
  mgrNoSongs: string;
  mgrEmptyPlaylist: string;
  mgrItems: string;
  mgrItemOne: string;
  mgrMarked: string;
  mgrOwnerYou: string;
  mgrOwnerOf: string;
  mgrReadOnly: string;
  mgrSharedWith: string;
  mgrNotShared: string;
  mgrMissingSong: string;
  mgrDownloaded: string;
  mgrNotDownloaded: string;
  mgrPreparing: string;
  mgrFavorite: string;
  mgrFilters: string;
  mgrFilterText: string;
  mgrFilterArtist: string;
  mgrFilterAlbum: string;
  mgrFilterType: string;
  mgrFilterSource: string;
  mgrFilterGenre: string;
  mgrFilterState: string;
  mgrFilterTags: string;
  mgrFilterYears: string;
  mgrNoYear: string;
  mgrFilterMembership: string;
  mgrMembershipAll: string;
  mgrMembershipIn: string;
  mgrMembershipNotIn: string;
  mgrFilterFavorites: string;
  mgrFilterListened: string;
  mgrFiltersReset: string;
  mgrStateAll: string;
  mgrSort: string;
  mgrTypeAudio: string;
  mgrTypeAi: string;
  mgrTypeBoth: string;
  mgrTypeList: string;
  mgrTypeSpotify: string;
  mgrTypeShazam: string;
  mgrFnBar: string;
  mgrFnHelp: string;
  mgrFnDetails: string;
  mgrFnRename: string;
  mgrFnCopy: string;
  mgrFnMove: string;
  mgrFnNew: string;
  mgrFnRemove: string;
  mgrFnShare: string;
  mgrFnPlay: string;
  mgrFnUndo: string;
  mgrWhyBusy: string;
  mgrWhyNothing: string;
  mgrWhyLibrary: string;
  mgrWhyReadOnly: string;
  mgrWhyNoTarget: string;
  mgrWhySamePlaylist: string;
  mgrWhyNotOwner: string;
  mgrWhyFiltered: string;
  mgrWhyNotAuth: string;
  mgrWhyNoUndo: string;
  mgrProgress: string;
  mgrOpCopy: string;
  mgrOpMove: string;
  mgrOpRemove: string;
  mgrOpUndo: string;
  mgrResAdded: string;
  mgrResAlready: string;
  mgrResRemoved: string;
  mgrResFailed: string;
  mgrResNotTried: string;
  mgrResNothing: string;
  mgrResDetails: string;
  mgrResHide: string;
  mgrResRetry: string;
  mgrResUndo: string;
  mgrResUndone: string;
  mgrResDismiss: string;
  mgrResStepAdd: string;
  mgrResStepRemove: string;
  mgrResStepReorder: string;
  mgrReorderFailed: string;
  mgrNewTitle: string;
  mgrNewPlaceholder: string;
  mgrNewDone: string;
  mgrRenameTitle: string;
  mgrRenameDone: string;
  mgrRemoveTitle: string;
  mgrRemoveConfirm: string;
  mgrMarkTitle: string;
  mgrUnmarkTitle: string;
  mgrPatternHelp: string;
  mgrPatternPlaceholder: string;
  mgrShareTitle: string;
  mgrShareHint: string;
  mgrShareNobody: string;
  mgrShareOwner: string;
  mgrShareLoading: string;
  mgrShareError: string;
  mgrClose: string;
  mgrConfirm: string;
  mgrDetailsTitle: string;
  mgrDetailsAlbum: string;
  mgrDetailsGenres: string;
  mgrDetailsType: string;
  mgrDetailsSource: string;
  mgrDetailsTags: string;
  mgrDetailsMentions: string;
  mgrDetailsFile: string;
  mgrDetailsFilePresent: string;
  mgrDetailsFileMissing: string;
  mgrShowPaths: string;
  mgrShowPathsHint: string;
  mgrDetailsWhere: string;
  mgrWhereFs: string;
  mgrWhereMs: string;
  mgrWhereYoutube: string;
  mgrWhereNone: string;
  mgrWhereNoPath: string;
  mgrWhereSearch: string;
  mgrCopy: string;
  mgrCopied: string;
  mgrCopyFailed: string;
  mgrCopyWhat: string;
  mgrDetailsOpen: string;
  mgrDetailsPlaceholder: string;
  mgrCannotPlay: string;
  mgrHelpTitle: string;
  mgrFnDynamic: string;
  mgrFnRule: string;
  mgrWhyDynamic: string;
  mgrWhyNotDynamic: string;
  mgrDynamicPill: string;
  mgrDynamicEvaluated: string;
  mgrDynamicRefresh: string;
  mgrDynamicNever: string;
  mgrRuleCreated: string;
  mgrRuleUpdated: string;
  dynTitleNew: string;
  dynTitleEdit: string;
  dynIntro: string;
  dynPresetNone: string;
  dynPreset: string;
  dynName: string;
  dynNameFixed: string;
  dynScope: string;
  dynScopeMe: string;
  dynScopeFamily: string;
  dynPeriod: string;
  dynPeriodDays: string;
  dynPeriodAll: string;
  dynWindowEnable: string;
  dynFrom: string;
  dynTo: string;
  dynWindowLocal: string;
  dynCrossesMidnight: string;
  dynWindowIgnored: string;
  dynDays: string;
  dynDaysAll: string;
  dynDaysShort: string[];
  dynDaysLong: string[];
  dynGenres: string;
  dynGenresHint: string;
  dynOrder: string;
  dynOrderMost: string;
  dynOrderLeast: string;
  dynOrderRecent: string;
  dynOrderNever: string;
  dynOrderNewest: string;
  dynNewestNote: string;
  dynLimit: string;
  dynMinPlays: string;
  dynDownloadedOnly: string;
  dynSummary: string;
  dynMax: string;
  dynFamily: string;
  dynDownloadedShort: string;
  dynMidnightShort: string;
  dynIssueNameRequired: string;
  dynIssueNameLong: string;
  dynIssueLimit: string;
  dynIssueMinPlays: string;
  dynIssueWindowTime: string;
  dynIssueWindowEmpty: string;
  dynCreate: string;
  dynSave: string;
  statsNav: string;
  statsTitle: string;
  statsSubtitleMe: string;
  statsSubtitleAll: string;
  statsSubtitleUser: string;
  statsPeriod: string;
  statsPeriodDays: string;
  statsPeriodAll: string;
  statsScope: string;
  statsScopeMe: string;
  statsScopeAll: string;
  statsUser: string;
  statsAllUsers: string;
  statsDevice: string;
  statsAllDevices: string;
  statsReload: string;
  statsLoading: string;
  statsError: string;
  statsEmptyTitle: string;
  statsEmptyBody: string;
  statsEmptyNever: string;
  statsTotals: string;
  statsPlays: string;
  statsSkips: string;
  statsListened: string;
  statsSongs: string;
  statsArtists: string;
  statsDevices: string;
  statsNeverPlayed: string;
  statsNeverPlayedHint: string;
  statsPerDay: string;
  statsPerDaySummary: string;
  statsDayTip: string;
  statsHeatmap: string;
  statsHeatmapSummary: string;
  statsHeatmapNone: string;
  statsHeatmapTip: string;
  statsTopSongs: string;
  statsTopArtists: string;
  statsTopGenres: string;
  statsPerDevice: string;
  statsPerOrigin: string;
  statsOriginLocal: string;
  statsOriginStream: string;
  statsOriginWeb: string;
  statsRankEmpty: string;
  statsPlaysCount: string;
  statsPlaysOne: string;
  statsRecent: string;
  statsColWhen: string;
  statsColSong: string;
  statsColUser: string;
  statsColDevice: string;
  statsColListened: string;
  statsColCounts: string;
  statsCounted: string;
  statsSkipped: string;
  statsTable: string;
  statsColDay: string;
  playerDlRequesting: string;
  playerDlDownloading: string;
  playerDlReady: string;
  playerDlFailed: string;
  playerDlUnavailable: string;
  playerDlTimeout: string;
  locFs: string;
  locMs: string;
  locFsMs: string;
  locYoutube: string;
  sourceLabel: string;
  sourceAuto: string;
  sourceInternet: string;
  sourceMedia: string;
  sourceAutoTitle: string;
  sourceInternetTitle: string;
  sourceMediaTitle: string;
  sourceHintInternal: string;
  sourceHintExternal: string;
  sourceHintFailed: string;
  sourceNextSong: string;
  sourcePlayingFrom: string;
  sourceFromMedia: string;
  sourceFromDisk: string;
  sourceFromYoutube: string;
  playerVideoTitle: string;
  playerVideoIdle: string;
  playerWindowStatus: string;
  playerWindowHidden: string;
  playerWindowHiddenOne: string;
  playerLoading: string;
  chOpen: string;
  chSearchLabel: string;
  chPlaylist: string;
  chAllSongs: string;
  chGenre: string;
  chYears: string;
  chNoYear: string;
  chAlbum: string;
  chArtist: string;
  chMoreOf: string;
  chMoreLabel: string;
  chMoreFilters: string;
  chSource: string;
  chTags: string;
  chDownloaded: string;
  chDlAll: string;
  chDlYes: string;
  chDlNo: string;
  chWhere: string;
  chFavorites: string;
  chNone: string;
  chPlay: string;
  chShuffle: string;
  chReset: string;
  chQueueSearch: string;
  chShowAll: string;
  chShowLess: string;
  chActive: string;
  chOf: string;
  chHint: string;
  mgrHelpLines: string[];

  // Notes page filters & categories
  notesMentions: string;
  categorySectionLabel: string;
  noteCategoryPlace: string;
  noteCategoryEvent: string;
  noteCategoryBrand: string;
  noteCategoryBook: string;
  noteCategoryProduct: string;
  noteCategoryQuote: string;
  noteCategoryPerson: string;
  noteCategoryOther: string;
}

export const translations: Record<Language, Translations> = {
  it: {
    // Header
    entries: 'entries',
    songs: 'canzoni',
    films: 'film',
    notes: 'note',
    software: 'software',
    navInbox: 'Inbox',
    navLinks: 'Link',
    navKbLabel: 'KB',
    shellNavLabel: 'Sezioni',
    shellGroupArchive: 'Archivio',
    shellGroupListen: 'Ascolto',
    shellPaste: 'Incolla un link',
    shellClearSearch: 'Cancella la ricerca',
    shellMore: 'Altro',
    shellPlayerLabel: 'Player',
    viewSwitchLabel: 'Vista della pagina',
    viewHome: 'Home',
    viewStudio: 'Studio',
    viewWall: 'Bacheca',
    prefsSaveError: 'Non riesco a salvare la scelta: la vista è tornata com\'era.',
    dismiss: 'Chiudi',
    detailClose: 'Chiudi il dettaglio',
    detailLabel: 'Dettaglio del post',
    wallLabel: 'Post della libreria',
    wallMoreSongs: '+{count} brani',
    wallMoreFilms: '+{count} film',
    homeSectionResume: 'Riprendi',
    homeSectionSongs: 'Nuove canzoni',
    homeSectionPlaylists: 'Le tue playlist',
    homeSectionCollections: 'Raccolte',
    homeSectionFilms: 'Da vedere',
    homeSeeAll: 'Vedi tutto ({count})',
    homeLoadError: 'Non riesco a caricare la Home.',
    homeEmpty: 'Niente da mostrare qui: incolla un link per cominciare.',
    shellPlay: 'Riproduci',
    shellPause: 'Pausa',
    shellNext: 'Brano successivo',
    shellPrevious: 'Brano precedente',
    shellSeek: 'Posizione nel brano',
    shellNothingPlaying: 'Niente in riproduzione',
    shellOpenPlayer: 'Apri il Player',
    navSearchPlaceholder: 'Cerca nella libreria…',
    libraryNav: 'Libreria',
    libraryTitle: 'Libreria media',
    libraryHint: 'Contenuti salvati in locale — aprili senza tornare online.',
    libraryEmpty: 'Nessun media locale trovato',
    localMediaSection: 'Media locale',
    localMediaBadge: 'Offline',
    framePrev: 'Frame precedente',
    frameNext: 'Frame successivo',
    deleteAll: 'Cancella tutto',
    deleting: 'Eliminazione...',
    console: 'Console',
    aiPrompts: 'Prompt AI',
    settings: 'Impostazioni',

    // Home
    inputPlaceholder: 'Incolla un link da Instagram, TikTok, YouTube...',
    analyze: 'Analizza',
    analyzing: 'Analisi...',
    analyzeHeroTitle: 'Salva un link nella libreria',
    analyzeHeroSub: 'Estrae canzoni, film e note. Aggiunge le tracce a Spotify.',
    analyzeHeroPlatforms: 'Instagram · TikTok · YouTube · web',
    urlAlreadyAnalyzed: 'URL già analizzato in precedenza',
    analysisComplete: 'Analisi completata!',
    loadMoreEntries: 'Carica altri link',
    entriesCountLabel: '{shown} di {total} link',

    // Journal
    loading: 'Caricamento...',
    noEntries: 'Nessuna entry',
    noEntriesHint: 'Incolla un link per iniziare',
    processing: 'In elaborazione...',
    error: 'Errore',
    noContentFound: 'Nessun contenuto trovato',

    // Entry Card
    songsSection: 'Canzoni',
    filmsSection: 'Film',
    deleteEntry: 'Elimina entry',
    confirmDelete: 'Sei sicuro di voler eliminare questa entry?',
    deleteError: 'Errore durante l\'eliminazione',
    showLog: 'Mostra log',
    hideLog: 'Nascondi log',

    // Caption toggle & Summary
    showMore: 'Mostra tutto',
    showLess: 'Mostra meno',
    summarySection: 'Sintesi',

    // Notes, Links, Tags
    notesSection: 'Note',
    linksSection: 'Link',
    tagsSection: 'Tag',
    notePlace: 'Luogo',
    noteEvent: 'Evento',
    noteBrand: 'Brand',
    noteBook: 'Libro',
    noteProduct: 'Prodotto',
    noteQuote: 'Citazione',
    notePerson: 'Persona',
    noteOther: 'Altro',

    // Song/Film Items
    addedToPlaylist: 'Aggiunta alla playlist',
    openOnSpotify: 'Apri su Spotify',
    searchOnYoutube: 'Cerca su YouTube',
    searchOnSoundcloud: 'Cerca su SoundCloud',
    searchOnSpotify: 'Cerca su Spotify',
    addToPlaylistBtn: 'Aggiungi alla playlist',
    addingToPlaylist: 'Aggiunta...',
    noSpotifyResults: 'Nessun risultato su Spotify',
    spotifyNotConnected: 'Connetti Spotify nelle impostazioni',
    openOnIMDb: 'Apri su IMDb',
    searchOnNetflix: 'Cerca su Netflix',
    searchOnPrimeVideo: 'Cerca su Prime Video',
    searchOnRaiPlay: 'Cerca su RaiPlay',
    searchOnNow: 'Cerca su NOW',
    searchOnDisneyPlus: 'Cerca su Disney+',
    searchOnAppleTv: 'Cerca su Apple TV',
    buyOnAmazon: 'Cerca su Amazon',
    searchOnGoogleBooks: 'Cerca su Google Books',
    by: 'di',
    director: 'Regista',
    year: 'Anno',

    // Settings
    settingsTitle: 'Impostazioni',
    backToJournal: '← Torna al Journal',
    spotify: 'Spotify',
    spotifyConnected: 'Connesso',
    spotifyDisconnected: 'Non connesso',
    spotifyHint: 'Collega il tuo account Spotify per aggiungere automaticamente le canzoni a una playlist.',
    connectSpotify: 'Collega Spotify',
    connecting: 'Connessione...',
    playlist: 'Playlist',

    // Features
    allowDuplicates: 'Ammetti URL duplicati',
    allowDuplicatesDescription: 'Disabilita il controllo di idempotenza. Permette di analizzare lo stesso URL più volte (utile per test).',
    shazamTitle: 'Riconoscimento Shazam',
    shazamDescription: 'Usa Shazam per riconoscere la musica nell\'audio estratto dai video.',
    multiSongTitle: 'Scan multi-canzone',
    multiSongDescription: 'Segmenta l\'audio con librosa per trovare più canzoni in un singolo video. Richiede Shazam attivo.',
    youtubeDirectTitle: 'Link YouTube diretto',
    youtubeDirectDescription: 'Risolve link YouTube diretti via yt-dlp invece di generare URL di ricerca generici.',
    carouselExtractionTitle: 'Estrazione carosello',
    carouselExtractionDescription: 'Estrae canzoni e film da ogni slide dei caroselli Instagram con analisi AI per slide.',

    // Language
    language: 'Lingua',
    languageDescription: 'Lingua dell\'interfaccia e dei testi generati dall\'AI (riassunti, slide, note)',
    italian: 'Italiano',
    english: 'English',

    // Console
    debugConsole: 'Debug Console',
    home: 'Home',
    logs: 'log',
    live: 'LIVE',
    clearLogs: 'Cancella log',
    confirmClearLogs: 'Sei sicuro di voler cancellare tutti i log?',
    noLogsFound: 'Nessun log trovato',
    loadingLogs: 'Caricamento log...',
    level: 'Livello',
    function: 'Funzione',
    search: 'Cerca...',
    all: 'Tutti',
    data: 'Dati',
    errorLabel: 'Errore',

    // Prompts
    promptsTitle: 'Prompt AI',
    contentAnalysis: 'Analisi Contenuto',
    telegramResponse: 'Risposta Telegram',
    enrichmentPrompt: 'Enrichment OpenAI',
    variables: 'Variabili',
    availableVariables: 'Variabili disponibili',
    promptName: 'Nome del prompt',
    promptDescription: 'Descrizione',
    save: 'Salva',
    saving: 'Salvataggio...',
    reset: 'Reset',
    resetDefault: 'Ripristina default',
    resetConfirm: 'Sei sicuro di voler ripristinare il template di default?',
    lastUpdated: 'Ultimo aggiornamento',
    promptSaved: 'Prompt salvato con successo!',
    promptReset: 'Prompt ripristinato!',
    templateError: 'Errore nel template',
    templateValid: 'Template valido',
    loadError: 'Errore nel caricamento',
    saveError: 'Errore nel salvataggio',
    resetError: 'Errore nel reset',

    // Console additional
    entryId: 'Entry ID',
    allLevels: 'Tutti',
    allFunctions: 'Tutte',
    logsActivity: 'Attività',
    logsActor: 'Chi',
    searchLogs: 'Cerca nei log...',
    clearLogsError: 'Errore durante la cancellazione dei log',

    // OpenAI Enrichment
    openaiSection: 'OpenAI Deep Search',
    openaiDescription: 'Usa OpenAI con web search per arricchire i risultati con link verificati. Serve una API key da platform.openai.com.',
    openaiApiKey: 'API Key',
    openaiSaveSuccess: 'Configurazione OpenAI salvata!',
    openaiSaveError: 'Errore nel salvataggio della configurazione OpenAI',
    openaiHowTo: 'Vai su platform.openai.com/api-keys per generare una chiave.',

    // Retry & Enrich
    retryEntry: 'Rianalizza',
    retrying: 'Rianalisi...',
    enrichEntry: 'Arricchisci',
    enriching: 'Arricchimento...',
    enrichmentsSection: 'Approfondimenti',
    enrichError: 'Errore durante l\'arricchimento',
    retryError: 'Errore durante la rianalisi',

    // Media Analysis & Auto-enrich
    transcription: 'Trascrizione',
    visualContext: 'Contesto visivo',
    overlayText: 'Testo nel video',
    mediaAnalysis: 'Analisi media avanzata',
    mediaAnalysisDescription: 'Scarica audio/video e li analizza con AI per trascrizione, riconoscimento scene e testo sovrapposto.',
    mediaAnalysisPrompt: 'Analisi Media',
    pipelineFeatures: 'Pipeline',
    pageExtractionTitle: 'Estrazione pagine web',
    pageExtractionDescription: 'Per URL non Instagram (articoli, blog, social), estrae sintesi e link senza scaricare media.',

    aiAnalysisToggle: 'Analisi AI',
    aiAnalysisToggleDescription: 'Analizza il contenuto con AI per estrarre canzoni, film, note e tag.',
    transcriptionToggle: 'Trascrizione audio',
    transcriptionToggleDescription: 'Trascrive il parlato dall\'audio usando AI.',

    // Inspector
    selectEntry: 'Seleziona un\'entry per esplorare i dettagli',
    selectEntryHint: 'Clicca su una card a sinistra',
    openOriginal: 'Apri originale',
    copyUrl: 'Copia URL',
    shareEntry: 'Copia link condivisibile',
    urlCopied: 'URL copiato!',
    transcript: 'Trascrizione',
    deepSearch: 'Deep Search',
    runDeepSearch: 'Arricchisci',
    timeAgo: 'fa',
    justNow: 'adesso',
    minutesAgo: '{count}m fa',
    hoursAgo: '{count}h fa',
    yesterday: 'ieri',
    daysAgo: '{count}g fa',
    back: '← Indietro',

    // Danger Zone
    dangerZone: 'Zona pericolosa',
    mfTitle: 'Cartelle musica',
    mfIntro: 'La ricerca nei file locali legge la cartella di Spooty e le cartelle extra che aggiungi qui. Sono lette in sola lettura: il backend non le modifica mai.',
    mfBuiltIn: 'Integrata',
    mfBuiltInNote: 'Sempre inclusa, non modificabile.',
    mfRoots: 'Posizioni consentite (montate nel container)',
    mfMountNote: 'Per cercare altre cartelle del computer vanno montate in sola lettura in docker-compose.yml sotto MUSIC_EXTRA_ROOTS (di solito /music-extra) e rilasciate con un deploy: da qui si scelgono solo quelle già montate.',
    mfNoExtra: 'Nessuna cartella extra. Aggiungine una per cercare anche lì.',
    mfAdd: 'Aggiungi cartella',
    mfRescan: 'Rianalizza ora',
    mfLabelOf: 'Etichetta della cartella {path}',
    mfSwitchOf: 'Cerca in {label}',
    mfRemove: 'Rimuovi',
    mfRemoveOf: 'Rimuovi la cartella {label} dall’elenco',
    mfRemoveHint: 'Toglie la cartella dalla ricerca; i file non vengono toccati.',
    mfStatusOk: 'pronta',
    mfStatusScanning: 'scansione in corso…',
    mfStatusPending: 'in attesa della scansione',
    mfStatusMissing: 'cartella non trovata',
    mfStatusOff: 'disattivata',
    mfFiles: '{n} file',
    mfFileOne: '1 file',
    mfTruncated: 'oltre il limite: alcuni file non sono indicizzati',
    mfScannedAt: 'ultima scansione {time}',
    mfNeverScanned: 'mai scansionata',
    mfSaving: 'Salvo…',
    mfLoading: 'Carico le cartelle…',
    mfLoadError: 'Cartelle musica non disponibili',
    mfRetry: 'Riprova',
    mfPickerTitle: 'Scegli una cartella',
    mfPickerRoots: 'Posizioni consentite',
    mfPickerCurrent: 'Cartella corrente',
    mfPickerHere: 'Aggiungi questa cartella',
    mfPickerUp: 'Su',
    mfPickerOpen: 'Apri {name}',
    mfPickerAdd: 'Aggiungi {name}',
    mfPickerEmpty: 'Nessuna sottocartella.',
    mfPickerNoRoots: 'Nessuna cartella extra montata. Montane una in docker-compose.yml sotto MUSIC_EXTRA_ROOTS.',
    mfPickerLoading: 'Carico…',
    mfErrOutside: 'La cartella è fuori dalle posizioni consentite (solo quelle montate nel container).',
    mfErrMissing: 'La cartella non esiste (o non è montata nel container).',
    mfErrNotDir: 'Il percorso non è una cartella.',
    mfErrIncluded: 'Questa cartella fa già parte della libreria di Spooty: si cerca per intero.',
    mfErrTooMany: 'Troppe cartelle: il massimo è 20.',
    mfErrInvalid: 'Percorso non valido: serve un percorso assoluto.',
    mfErrForbidden: 'Solo l’admin può cambiare le cartelle musica.',
    mfErrNetwork: 'Server non raggiungibile.',
    mfErrUnknown: 'Operazione non riuscita: {detail}',
    mfErrAt: '«{path}»: {message}',
    deleteAllDescription: 'Elimina tutte le entry dal database. Questa azione non può essere annullata.',

    // Errors
    errorGeneric: 'Si è verificato un errore',
    errorAnalysis: 'Errore durante l\'analisi',
    errorDelete: 'Errore durante l\'eliminazione',
    errorSettings: 'Errore durante l\'aggiornamento delle impostazioni',

    // Confirmations
    confirmDeleteAll: 'Sei sicuro di voler eliminare tutte le {count} entry? Questa azione non può essere annullata.',
    deleted: 'Eliminate {count} entry',

    // Recent section
    recentEntries: 'Oggi',
    filterToggle: 'Filtra',
    seeAllJournal: 'Apri tutta la libreria →',
    inboxEmptyHint: 'Incolla un link sopra, oppure apri una card recente.',

    // Pagination & List Pages
    previousPage: '← Precedente',
    nextPage: 'Successiva →',
    pageOf: 'Pagina {page} di {total}',
    allEntries: 'Libreria link',
    allSongs: 'Tutte le canzoni',
    allFilms: 'Tutti i film',
    allNotes: 'Tutte le note',
    allSoftware: 'Software',
    noSoftwareYet: 'Nessun software trovato',
    softwareTagSection: 'Tag',
    softwareTagRepo: 'Repo',
    softwareTagProduct: 'Prodotto',
    softwareTagArticle: 'Articolo',
    softwareTagOther: 'Altro',
    softwareOpenLink: 'Apri',
    softwarePublished: 'Pubblicato',
    sortByTitle: 'Titolo',
    viewReel: 'Vedi reel →',
    sortRecent: 'Recenti',
    sortArtist: 'Artista A-Z',
    sortTitle: 'Titolo A-Z',
    sortFrequency: 'Più frequenti',
    unknownArtist: 'Artista sconosciuto',
    slidesSection: 'Pagine del carosello',
    slideCounter: 'Slide {n} / {total}',
    slideSuggestedLinks: 'Link suggeriti:',
    slideOcrText: 'Testo estratto dalla slide',
    openEntry: 'Apri →',
    today: 'Oggi',
    noSongsYet: 'Nessuna canzone trovata',
    libScopeLabel: 'Cerca in',
    libScopeSongs: 'Libreria',
    libScopeMedia: 'Media server',
    libScopeLocal: 'File locali',
    libScopeAll: 'Tutto',
    libScopeTitle: 'Dove cercare: le canzoni della libreria, il catalogo del media server, i file su disco (cartella di Spooty e cartelle extra)',
    libMinChars: 'Scrivi almeno 2 caratteri per cercare nei file.',
    libSearching: 'Cerco…',
    libResultsLabel: 'Risultati della ricerca',
    libSummaryAll: 'Libreria {songs} · Media server {media} · File locali {local}',
    libSummaryOne: '{n} risultati in {scope}',
    libSummarySingle: '1 risultato in {scope}',
    libNone: 'Nessun risultato per «{q}» in {scope}.',
    libElsewhere: 'Trovati altrove:',
    libNoSongsHere: 'Nessun brano della libreria corrisponde.',
    libShownOf: 'Mostro i primi {shown} di {total}',
    libInfoOnly: 'La ricerca dice dove stanno i brani: trovarli non li importa nella libreria e non li suona.',
    libInJournal: 'già in libreria',
    libInJournalTitle: 'Questo brano è già tra le canzoni della libreria',
    libCopyPath: 'percorso',
    libCopyUrl: 'URL',
    libErrForbidden: 'Non hai il permesso di cercare nei file.',
    libErrNetwork: 'Server non raggiungibile.',
    libErrServer: 'Ricerca non disponibile in questo momento.',
    libErrInvalid: 'Ricerca non valida.',
    libRetry: 'Riprova',
    noFilmsYet: 'Nessun film trovato',
    noNotesYet: 'Nessuna nota trovata',

    searchPlaceholder: 'Cerca...',
    filtersButton: 'Filtri',
    filtersReset: 'Azzera',
    filtersTitle: 'Filtri',
    genreSectionLabel: 'Genere',
    sortLabel: 'Ordina per',
    sortByDate: 'Data',
    sortByMentions: 'Menzioni',
    sortByDirector: 'Regista',
    sortByArtist: 'Artista',

    filmsFilterAll: 'Tutti',
    filmsFilterWatched: 'Visti',
    filmsFilterUnwatched: 'Non visti',
    filmsFilterFree: 'Gratis',
    filmsFilterNotFree: 'Non gratis',
    filmsShelfLabel: 'Lista piattaforma',
    filmsShelfNetflix: 'Netflix',
    filmsShelfPrime: 'Prime',
    filmsShelfRaiPlay: 'RaiPlay',
    filmsOpenOnPlatform: 'Apri sulla piattaforma',
    filmsMentions: 'menzioni',
    filmsMarkFresh: 'Fresco',
    filmsMarkRotten: 'Marcio',
    filmsMarkWatched: 'Segna come visto',
    filmsScorePlaceholder: '%',
    filmsAvailabilityHint: 'Disponibilità: click sul punto per cambiare stato',
    licensesTitle: 'Licenze e attribuzioni',
    licensesDataProviders: 'Fonti dati',
    licensesOssTitle: 'Dipendenze open source',
    licensesPackage: 'Pacchetto',
    licensesVersion: 'Versione',
    licensesLicense: 'Licenza',
    licensesLink: 'Licenze',
    filmsWatchedFilterLabel: 'Visto',
    filmsAvailabilityFilterLabel: 'Disponibilità',
    filmsTmdbScore: 'Voto TMDb',
    filmsRefreshStreaming: 'Aggiorna disponibilità',
    filmsStreamFree: 'Gratis',
    filmsStreamSub: 'Abbonamento',
    filmsStreamRent: 'Noleggio',
    filmsStreamBuy: 'Acquisto',
    filmsArchiveBadge: 'Archive',
    filmsArchiveLookup: 'Cerca su Internet Archive',
    filmsArchiveDownload: 'Scarica in archivio',
    filmsArchiveDownloaded: 'Scaricato in archivio',
    filmsArchiveNone: 'Nessuna copia di pubblico dominio trovata',

    songsFilterListened: 'Ascoltate',
    songsFilterUnlistened: 'Da ascoltare',
    songsFilterFavorites: 'Preferite',
    songsFilterDownloaded: 'Scaricate',
    songsFilterNotDownloaded: 'Non scaricate',
    songsListenedFilterLabel: 'Ascoltata',
    songsDownloadedFilterLabel: 'Scaricata',
    songsMarkLike: 'Mi piace',
    songsMarkDislike: 'Non mi piace',
    songsMarkListened: 'Segna come ascoltata',
    songsMarkFavorite: 'Preferita',
    songsMarkDownloaded: 'Scaricata (Spooty)',
    songsDownloadedLink: 'Scaricata — apri il player',
    songsDownloadFile: 'Scarica MP3',
    songsOpenSpooty: 'Apri Spooty',
    songsFileMissing: 'File non trovato nella libreria musicale',
    songsPreview: 'Anteprima',
    songsMentions: 'menzioni',
    fromPost: 'Dal post',
    versionOf: 'Versione di',
    softwareOtherLinks: 'Altri link',
    playerNav: 'Player',
    playerTitle: 'Player',
    playerOpen: '▶ Player',
    playerEmpty: 'Nessun brano in questa vista',
    playerEmptyHint: 'Cambia filtro — la riproduzione è su YouTube',
    playerFilterAll: 'Tutte',
    playerFilterLiked: 'Liked',
    playerPreviewOnly: 'solo preview',
    playerShuffle: 'Shuffle',
    playerRepeatOff: 'Repeat off',
    playerRepeatAll: 'Repeat all',
    playerRepeatOne: 'Repeat one',
    playerNowPlaying: 'In riproduzione',
    playerQueue: 'Coda',
    playerBrowseHint: 'Tocca un brano per impostare la coda',
    playlistsTitle: 'Playlist',
    playlistCreate: 'Crea',
    playlistCreateNew: 'Crea nuova',
    playlistNamePlaceholder: 'Nome playlist…',
    playlistEmpty: 'Nessuna playlist — creane una',
    playlistShowAll: 'Mostra tutte',
    playlistAddHint: 'Scegli una playlist per aggiungere il brano',
    playlistAddSong: 'Aggiungi a playlist',
    playlistRemoveSong: 'Rimuovi dalla playlist',
    playlistRename: 'Rinomina',
    playlistDelete: 'Elimina',
    playlistDeleteConfirm: 'Eliminare questa playlist?',
    playlistSave: 'Salva',
    playlistCancel: 'Annulla',
    playlistError: 'Operazione playlist non riuscita',
    playlistSearchPlaceholder: 'Cerca nelle playlist',
    playlistFilterLabel: 'Mostra',
    playlistFilterAll: 'Tutte',
    playlistFilterAuto: 'Automatiche',
    playlistFilterMine: 'Mie',
    playlistFilterShared: 'Condivise',
    playlistFilterDynamic: 'Dinamiche',
    playlistSortLabel: 'Ordina le playlist per',
    playlistSortCreated: 'Data di creazione',
    playlistSortUpdated: 'Ultima modifica',
    playlistSortName: 'Nome',
    playlistSortSize: 'Numero di brani',
    playlistOrderDesc: 'Dal più alto o più recente: tocca per invertire',
    playlistOrderAsc: 'Dal più basso o più vecchio: tocca per invertire',
    playlistShowMore: 'Mostra altre',
    playlistShownOf: '{shown} di {total}',
    playlistAutoBadge: 'automatica',
    playlistPanelShow: 'Mostra l’elenco delle playlist',
    playlistPanelHide: 'Nascondi l’elenco delle playlist',
    playlistNoMatch: 'Nessuna playlist corrisponde',
    playlistPlay: '▶ Riproduci',
    playlistActiveChip: 'Playlist',

    mgrTitle: 'Gestione playlist',
    mgrHint: 'Tab cambia pannello · Spazio segna · F5 copia · F6 sposta · F8 rimuove · F1 aiuto',
    mgrLibrary: 'Tutti i brani',
    mgrFileOnly: 'Solo file',
    playerShowing: 'Mostrati {shown} di {total}',
    playerShowMore: 'Mostra altri {n}',
    mgrFileOnlyHint: 'Esiste solo come file (geekom o media server): non è in nessun post del journal',
    mgrShowMore: 'Mostra altri {n}',
    mgrShowing: 'Mostrati {shown} di {total}',
    mgrMine: 'Le mie playlist',
    mgrSharedWithMe: 'Condivise con me',
    mgrPaneA: 'Pannello A',
    mgrPaneB: 'Pannello B',
    mgrPanes: 'Pannelli',
    mgrLocationLabel: 'Contenuto del pannello',
    mgrReload: 'Ricarica',
    mgrLoadError: 'Caricamento non riuscito',
    mgrNoSongs: 'Nessun brano con questi filtri',
    mgrEmptyPlaylist: 'Playlist vuota — con F5 copia qui dei brani dall’altro pannello',
    mgrItems: '{n} brani',
    mgrItemOne: '1 brano',
    mgrMarked: '{n} segnati',
    mgrOwnerYou: 'tua',
    mgrOwnerOf: 'di {name}',
    mgrReadOnly: 'sola lettura',
    mgrSharedWith: 'Condivisa con: {names}',
    mgrNotShared: 'Non condivisa',
    mgrMissingSong: 'non nel tuo journal',
    mgrDownloaded: 'scaricata',
    mgrNotDownloaded: 'da scaricare',
    mgrPreparing: 'in preparazione',
    mgrFavorite: 'preferita',
    mgrFilters: 'Filtri',
    mgrFilterText: 'Cerca titolo, artista, album…',
    mgrFilterArtist: 'Autore',
    mgrFilterAlbum: 'Album',
    mgrFilterType: 'Riconosciuta da',
    mgrFilterSource: 'Fonte',
    mgrFilterGenre: 'Tipo (genere)',
    mgrFilterState: 'Stato',
    mgrFilterTags: 'Tag',
    mgrFilterYears: 'Anni',
    mgrNoYear: 'Senza anno',
    mgrFilterMembership: 'Rispetto all’altro pannello',
    mgrMembershipAll: 'Tutti',
    mgrMembershipIn: 'Già nell’altra playlist',
    mgrMembershipNotIn: 'Non ancora nell’altra playlist',
    mgrFilterFavorites: 'Solo preferite',
    mgrFilterListened: 'Ascolto',
    mgrFiltersReset: 'Azzera i filtri',
    mgrStateAll: 'Tutti',
    mgrSort: 'Ordina',
    mgrTypeAudio: 'Riconoscimento audio',
    mgrTypeAi: 'Analisi AI',
    mgrTypeBoth: 'Audio + AI',
    mgrTypeList: 'Lista',
    mgrTypeSpotify: 'Link Spotify',
    mgrTypeShazam: 'Link Shazam',
    mgrFnBar: 'Comandi',
    mgrFnHelp: 'Aiuto',
    mgrFnDetails: 'Dettagli',
    mgrFnRename: 'Rinomina',
    mgrFnCopy: 'Copia',
    mgrFnMove: 'Sposta',
    mgrFnNew: 'Nuova',
    mgrFnRemove: 'Rimuovi',
    mgrFnShare: 'Condividi',
    mgrFnPlay: 'Play',
    mgrFnUndo: 'Annulla',
    mgrWhyBusy: 'Operazione in corso',
    mgrWhyNothing: 'Nessun brano selezionato',
    mgrWhyLibrary: 'Non disponibile in «Tutti i brani»',
    mgrWhyReadOnly: 'Playlist condivisa con te: sola lettura',
    mgrWhyNoTarget: 'Serve una playlist modificabile nell’altro pannello',
    mgrWhySamePlaylist: 'I due pannelli mostrano la stessa playlist',
    mgrWhyNotOwner: 'Solo chi ha creato la playlist può condividerla o cambiarne la regola',
    mgrWhyFiltered: 'Togli i filtri per riordinare',
    mgrWhyNotAuth: 'Serve il login per condividere',
    mgrWhyNoUndo: 'Niente da annullare',
    mgrProgress: '{op} {done}/{total}…',
    mgrOpCopy: 'Copia',
    mgrOpMove: 'Sposta',
    mgrOpRemove: 'Rimuovi',
    mgrOpUndo: 'Annulla',
    mgrResAdded: '{n} aggiunti',
    mgrResAlready: '{n} già presenti',
    mgrResRemoved: '{n} rimossi',
    mgrResFailed: '{n} non riusciti',
    mgrResNotTried: '{n} non tentati (operazione interrotta)',
    mgrResNothing: 'Niente da fare',
    mgrResDetails: 'Dettagli',
    mgrResHide: 'Nascondi',
    mgrResRetry: 'Riprova gli errori',
    mgrResUndo: 'Annulla',
    mgrResUndone: 'Operazione annullata',
    mgrResDismiss: 'Chiudi',
    mgrResStepAdd: 'aggiunta',
    mgrResStepRemove: 'rimozione',
    mgrResStepReorder: 'ordine',
    mgrReorderFailed: 'Riordino non riuscito: {error}',
    mgrNewTitle: 'Nuova playlist',
    mgrNewPlaceholder: 'Nome della playlist',
    mgrNewDone: 'Playlist “{name}” creata (vuota)',
    mgrRenameTitle: 'Rinomina playlist',
    mgrRenameDone: 'Playlist rinominata',
    mgrRemoveTitle: 'Rimuovi dalla playlist',
    mgrRemoveConfirm: 'Rimuovere {n} brani da “{name}”? Restano in libreria.',
    mgrMarkTitle: 'Segna per testo',
    mgrUnmarkTitle: 'Togli il segno per testo',
    mgrPatternHelp: 'Testo libero, oppure * e ? come jolly (es. *live*)',
    mgrPatternPlaceholder: 'es. *live*',
    mgrShareTitle: 'Condividi “{name}”',
    mgrShareHint: 'Chi la riceve la vede e la ascolta in sola lettura.',
    mgrShareNobody: 'Nessun altro utente con cui condividere',
    mgrShareOwner: 'Proprietario: {name}',
    mgrShareLoading: 'Carico le condivisioni…',
    mgrShareError: 'Condivisione non riuscita',
    mgrClose: 'Chiudi',
    mgrConfirm: 'Conferma',
    mgrDetailsTitle: 'Dettagli brano',
    mgrDetailsAlbum: 'Album',
    mgrDetailsGenres: 'Generi',
    mgrDetailsType: 'Tipo',
    mgrDetailsSource: 'Fonte',
    mgrDetailsTags: 'Tag',
    mgrDetailsMentions: 'Menzioni nel journal',
    mgrDetailsFile: 'File',
    mgrDetailsFilePresent: 'MP3 sul server',
    mgrDetailsFileMissing: 'nessun MP3 sul server (il download parte al primo play)',
    mgrShowPaths: 'Mostra percorsi',
    mgrShowPathsHint: 'Sotto ogni brano: dove sta il file (disco, media server) o il link YouTube',
    mgrDetailsWhere: 'Posizione',
    mgrWhereFs: 'Disco di geekom (FS)',
    mgrWhereMs: 'Media server (MS)',
    mgrWhereYoutube: 'YouTube',
    mgrWhereNone: 'non c’è',
    mgrWhereNoPath: 'percorso non comunicato dal server',
    mgrWhereSearch: 'ricerca: il video non è ancora noto',
    mgrCopy: 'Copia',
    mgrCopied: 'Copiato',
    mgrCopyFailed: 'Copia non riuscita',
    mgrCopyWhat: 'Copia {what}',
    mgrDetailsOpen: 'Apri',
    mgrDetailsPlaceholder: 'Brano di una playlist condivisa: non è nel tuo journal, quindi da qui non si può riprodurre.',
    mgrCannotPlay: 'Brano non riproducibile da qui (non è nel tuo journal)',
    mgrHelpTitle: 'Scorciatoie',
    mgrFnDynamic: 'Dinamica',
    mgrFnRule: 'Regola',
    mgrWhyDynamic: 'Playlist dinamica: i brani li sceglie la regola (si cambia la regola, non i brani)',
    mgrWhyNotDynamic: 'Solo le playlist dinamiche hanno una regola',
    mgrDynamicPill: 'dinamica',
    mgrDynamicEvaluated: 'valutata alle {time}',
    mgrDynamicRefresh: 'Ricalcola',
    mgrDynamicNever: 'non ancora valutata',
    mgrRuleCreated: 'Playlist dinamica “{name}” creata: {n} brani',
    mgrRuleUpdated: 'Regola aggiornata: {n} brani',
    dynTitleNew: 'Nuova playlist dinamica',
    dynTitleEdit: 'Regola di “{name}”',
    dynIntro: 'Si ricalcola a ogni richiesta (e a ogni Sync): i brani cambiano con gli ascolti. I brani non si aggiungono né si tolgono a mano.',
    dynPresetNone: 'Parti da un preset…',
    dynPreset: 'Preset',
    dynName: 'Nome',
    dynNameFixed: 'Il nome di una playlist dinamica non si cambia.',
    dynScope: 'Di chi sono gli ascolti',
    dynScopeMe: 'Solo i miei',
    dynScopeFamily: 'Di tutta la famiglia',
    dynPeriod: 'Periodo',
    dynPeriodDays: 'ultimi {n} giorni',
    dynPeriodAll: 'da sempre',
    dynWindowEnable: 'Solo ascolti in una fascia oraria',
    dynFrom: 'Dalle',
    dynTo: 'Alle',
    dynWindowLocal: 'Ora locale dell’ascolto (non quella del server).',
    dynCrossesMidnight: 'Attraversa la mezzanotte: dalle {from} di sera alle {to} del giorno dopo.',
    dynWindowIgnored: 'La fascia oraria non si applica ai brani mai ascoltati.',
    dynDays: 'Giorni',
    dynDaysAll: 'Nessuno scelto = tutti i giorni',
    dynDaysShort: [
      'lun',
      'mar',
      'mer',
      'gio',
      'ven',
      'sab',
      'dom',
    ],
    dynDaysLong: [
      'lunedì',
      'martedì',
      'mercoledì',
      'giovedì',
      'venerdì',
      'sabato',
      'domenica',
    ],
    dynGenres: 'Tipo (genere)',
    dynGenresHint: 'Nessuno scelto = tutti i generi',
    dynOrder: 'Ordine',
    dynOrderMost: 'Più ascoltate',
    dynOrderLeast: 'Meno ascoltate',
    dynOrderRecent: 'Ascoltate di recente',
    dynOrderNever: 'Mai ascoltate',
    dynOrderNewest: 'Aggiunte di recente',
    dynNewestNote: 'Questa regola guarda la libreria, non gli ascolti: periodo, fascia oraria, famiglia e numero minimo di ascolti non contano. Prende ogni brano col genere scelto, i più recenti per primi.',
    dynLimit: 'Numero massimo di brani (1–200)',
    dynMinPlays: 'Ascolti minimi',
    dynDownloadedOnly: 'Solo brani già scaricati',
    dynSummary: 'Riepilogo',
    dynMax: 'max {n}',
    dynFamily: 'famiglia',
    dynDownloadedShort: 'solo scaricate',
    dynMidnightShort: 'oltre la mezzanotte',
    dynIssueNameRequired: 'Serve un nome.',
    dynIssueNameLong: 'Il nome è troppo lungo (max 80 caratteri).',
    dynIssueLimit: 'Il numero massimo di brani va da 1 a 200.',
    dynIssueMinPlays: 'Gli ascolti minimi sono un numero intero, 0 o più.',
    dynIssueWindowTime: 'Gli orari non sono validi (formato HH:MM).',
    dynIssueWindowEmpty: 'Inizio e fine coincidono: la fascia sarebbe vuota.',
    dynCreate: 'Crea la playlist',
    dynSave: 'Salva la regola',
    statsNav: 'Statistiche',
    statsTitle: 'Statistiche di ascolto',
    statsSubtitleMe: 'I tuoi ascolti',
    statsSubtitleAll: 'Gli ascolti di tutti',
    statsSubtitleUser: 'Gli ascolti di {user}',
    statsPeriod: 'Periodo',
    statsPeriodDays: '{n} giorni',
    statsPeriodAll: 'Tutto',
    statsScope: 'Ascolti di',
    statsScopeMe: 'Solo i miei',
    statsScopeAll: 'Tutti',
    statsUser: 'Utente',
    statsAllUsers: 'Tutti gli utenti',
    statsDevice: 'Dispositivo',
    statsAllDevices: 'Tutti i dispositivi',
    statsReload: 'Aggiorna',
    statsLoading: 'Carico le statistiche…',
    statsError: 'Statistiche non disponibili',
    statsEmptyTitle: 'Ancora nessun ascolto registrato',
    statsEmptyBody: 'Gli ascolti si registrano dal player web e da Mondrop. Ascolta qualche brano (almeno 3 secondi) e torna qui: contano quelli ascoltati per 30 secondi o per metà brano, il resto sono salti.',
    statsEmptyNever: 'Brani della libreria mai ascoltati: {n}',
    statsTotals: 'Totali',
    statsPlays: 'Ascolti',
    statsSkips: 'Salti',
    statsListened: 'Tempo ascoltato',
    statsSongs: 'Brani distinti',
    statsArtists: 'Artisti distinti',
    statsDevices: 'Dispositivi',
    statsNeverPlayed: 'Mai ascoltati',
    statsNeverPlayedHint: 'brani della libreria',
    statsPerDay: 'Ascolti per giorno',
    statsPerDaySummary: 'Ascolti per giorno: {days} giorni, {plays} ascolti in totale, il massimo in un giorno è {max}.',
    statsDayTip: '{day}: {plays} ascolti, {time}',
    statsHeatmap: 'Quando ascolti (ora locale)',
    statsHeatmapSummary: 'Mappa degli ascolti per giorno della settimana e ora locale. Picco: {day} alle {hour}, {n} ascolti.',
    statsHeatmapNone: 'Mappa degli ascolti per giorno della settimana e ora locale: nessun ascolto.',
    statsHeatmapTip: '{day} {hour}: {n} ascolti',
    statsTopSongs: 'Brani più ascoltati',
    statsTopArtists: 'Artisti più ascoltati',
    statsTopGenres: 'Tipi (generi) più ascoltati',
    statsPerDevice: 'Per dispositivo',
    statsPerOrigin: 'Per origine',
    statsOriginLocal: 'Sul telefono (file scaricato)',
    statsOriginStream: 'In streaming dal server',
    statsOriginWeb: 'Player web',
    statsRankEmpty: 'Nessun dato nel periodo',
    statsPlaysCount: '{n} ascolti',
    statsPlaysOne: '1 ascolto',
    statsRecent: 'Ultimi ascolti',
    statsColWhen: 'Quando',
    statsColSong: 'Brano',
    statsColUser: 'Utente',
    statsColDevice: 'Dispositivo',
    statsColListened: 'Ascoltato',
    statsColCounts: 'Esito',
    statsCounted: 'conta',
    statsSkipped: 'salto',
    statsTable: 'Tabella dei dati',
    statsColDay: 'Giorno',
    playerDlRequesting: 'richiedo il download…',
    playerDlDownloading: 'scarico in parallelo…',
    playerDlReady: 'scaricata — la prossima volta è locale',
    playerDlFailed: 'download non riuscito',
    playerDlUnavailable: 'nessuna sorgente trovata',
    playerDlTimeout: 'ancora in preparazione',
    locFs: 'File sul disco di geekom (server)',
    locMs: 'Sul media server (Fritz)',
    locFsMs: 'Sul disco di geekom e sul media server',
    locYoutube: 'In streaming: link YouTube',
    sourceLabel: 'Sorgente',
    sourceAuto: 'Auto',
    sourceInternet: 'Internet',
    sourceMedia: 'Media server',
    sourceAutoTitle: 'Automatica: in rete interna suona dal media server, da internet suona da Internet (YouTube)',
    sourceInternetTitle: 'Sempre da Internet (YouTube): il video prende il posto della copertina',
    sourceMediaTitle: 'Il file di casa, passando dal server (anche da internet). Se il brano non c’è suona da Internet e parte il download',
    sourceHintInternal: 'Auto: rete interna → media server',
    sourceHintExternal: 'Auto: da internet → Internet',
    sourceHintFailed: 'Auto: rete non rilevata → Internet',
    sourceNextSong: 'Vale dal prossimo brano',
    sourcePlayingFrom: 'Suona da',
    sourceFromMedia: 'Media server',
    sourceFromDisk: 'Disco di casa',
    sourceFromYoutube: 'Internet (YouTube)',
    playerVideoTitle: 'Video: {title} — {artist}',
    playerVideoIdle: 'Video del brano in riproduzione',
    playerWindowStatus: '{shown} di {total}',
    playerWindowHidden: '{n} già ascoltate nascoste',
    playerWindowHiddenOne: '1 già ascoltata nascosta',
    playerLoading: 'Sto caricando…',
    chOpen: 'Scegli cosa suonare',
    chSearchLabel: 'Cerca nelle canzoni',
    chPlaylist: 'Playlist',
    chAllSongs: 'Tutte le canzoni',
    chGenre: 'Tipo',
    chYears: 'Anni',
    chNoYear: 'Senza anno',
    chAlbum: 'Album',
    chArtist: 'Autore',
    chMoreOf: 'Altri ({n})…',
    chMoreLabel: 'Altri valori: {legend}',
    chMoreFilters: 'Altri filtri',
    chSource: 'Fonte',
    chTags: 'Tag',
    chDownloaded: 'Scaricata',
    chDlAll: 'Tutte',
    chDlYes: 'Scaricate',
    chDlNo: 'Da scaricare',
    chWhere: 'Dove sta',
    chFavorites: 'Solo preferite',
    chNone: 'Nessun brano con questi filtri.',
    chPlay: 'Suona',
    chShuffle: 'Mescola e suona',
    chReset: 'Azzera i filtri',
    chQueueSearch: 'Ricerca: {q}',
    chShowAll: 'Mostra tutti ({n})',
    chShowLess: 'Mostra meno',
    chActive: '{n} filtri attivi',
    chOf: 'su {n}',
    chHint: 'I filtri si sommano; dentro un filtro si può sceglierne più di uno. Il risultato diventa la coda.',
    mgrHelpLines: [
      'Tab — passa all’altro pannello (Maiusc+Tab esce dalla lista)',
      '↑ ↓ Home Fine PagSu PagGiù — muovi il cursore',
      'Spazio / Ins — segna e scendi · + segna per testo · - toglie il segno · * inverte · Ctrl+A tutti',
      'Invio — riproduci · F3 — dettagli',
      'F4 rinomina · F5 copia nell’altro pannello · F6 sposta · F7 nuova playlist · F8 (o Canc) rimuovi · F9 condividi',
      'Ctrl+↑ / Ctrl+↓ — riordina nella playlist · Ctrl+Z annulla l’ultima operazione',
      'F2 nuova playlist dinamica (regola: fascia oraria, giorni, periodo, tipo, ordine) · F4 su una dinamica modifica la regola',
      'Esc — chiude, toglie i segni, poi porta ai comandi',
    ],

    notesMentions: 'menzioni',
    categorySectionLabel: 'Categoria',
    noteCategoryPlace: 'Luogo',
    noteCategoryEvent: 'Evento',
    noteCategoryBrand: 'Brand',
    noteCategoryBook: 'Libro',
    noteCategoryProduct: 'Prodotto',
    noteCategoryQuote: 'Citazione',
    noteCategoryPerson: 'Persona',
    noteCategoryOther: 'Altro',
  },

  en: {
    // Header
    entries: 'entries',
    songs: 'songs',
    films: 'films',
    notes: 'notes',
    software: 'software',
    navInbox: 'Inbox',
    navLinks: 'Links',
    navKbLabel: 'KB',
    shellNavLabel: 'Sections',
    shellGroupArchive: 'Library',
    shellGroupListen: 'Listen',
    shellPaste: 'Paste a link',
    shellClearSearch: 'Clear the search',
    shellMore: 'More',
    shellPlayerLabel: 'Player',
    viewSwitchLabel: 'Page view',
    viewHome: 'Home',
    viewStudio: 'Studio',
    viewWall: 'Wall',
    prefsSaveError: 'Could not save your choice: the view went back to how it was.',
    dismiss: 'Dismiss',
    detailClose: 'Close the detail',
    detailLabel: 'Post detail',
    wallLabel: 'Library posts',
    wallMoreSongs: '+{count} songs',
    wallMoreFilms: '+{count} films',
    homeSectionResume: 'Pick up',
    homeSectionSongs: 'New songs',
    homeSectionPlaylists: 'Your playlists',
    homeSectionCollections: 'Collections',
    homeSectionFilms: 'To watch',
    homeSeeAll: 'See all ({count})',
    homeLoadError: 'Could not load the Home.',
    homeEmpty: 'Nothing to show here: paste a link to start.',
    shellPlay: 'Play',
    shellPause: 'Pause',
    shellNext: 'Next song',
    shellPrevious: 'Previous song',
    shellSeek: 'Position in the song',
    shellNothingPlaying: 'Nothing playing',
    shellOpenPlayer: 'Open the Player',
    navSearchPlaceholder: 'Search the library…',
    libraryNav: 'Library',
    libraryTitle: 'Media library',
    libraryHint: 'Saved local media — review offline without going back online.',
    libraryEmpty: 'No local media found',
    localMediaSection: 'Local media',
    localMediaBadge: 'Offline',
    framePrev: 'Previous frame',
    frameNext: 'Next frame',
    deleteAll: 'Delete all',
    deleting: 'Deleting...',
    console: 'Console',
    aiPrompts: 'AI Prompts',
    settings: 'Settings',

    // Home
    inputPlaceholder: 'Paste a link from Instagram, TikTok, YouTube...',
    analyze: 'Analyze',
    analyzing: 'Analyzing...',
    analyzeHeroTitle: 'Save a link to your library',
    analyzeHeroSub: 'Extracts songs, films and notes. Adds tracks to Spotify.',
    analyzeHeroPlatforms: 'Instagram · TikTok · YouTube · web',
    urlAlreadyAnalyzed: 'URL already analyzed',
    analysisComplete: 'Analysis complete!',
    loadMoreEntries: 'Load more links',
    entriesCountLabel: '{shown} of {total} links',

    // Journal
    loading: 'Loading...',
    noEntries: 'No entries',
    noEntriesHint: 'Paste a link to get started',
    processing: 'Processing...',
    error: 'Error',
    noContentFound: 'No content found',

    // Entry Card
    songsSection: 'Songs',
    filmsSection: 'Films',
    deleteEntry: 'Delete entry',
    confirmDelete: 'Are you sure you want to delete this entry?',
    deleteError: 'Error deleting entry',
    showLog: 'Show log',
    hideLog: 'Hide log',

    // Caption toggle & Summary
    showMore: 'Show more',
    showLess: 'Show less',
    summarySection: 'Summary',

    // Notes, Links, Tags
    notesSection: 'Notes',
    linksSection: 'Links',
    tagsSection: 'Tags',
    notePlace: 'Place',
    noteEvent: 'Event',
    noteBrand: 'Brand',
    noteBook: 'Book',
    noteProduct: 'Product',
    noteQuote: 'Quote',
    notePerson: 'Person',
    noteOther: 'Other',

    // Song/Film Items
    addedToPlaylist: 'Added to playlist',
    openOnSpotify: 'Open on Spotify',
    searchOnYoutube: 'Search on YouTube',
    searchOnSoundcloud: 'Search on SoundCloud',
    searchOnSpotify: 'Search on Spotify',
    addToPlaylistBtn: 'Add to playlist',
    addingToPlaylist: 'Adding...',
    noSpotifyResults: 'No results on Spotify',
    spotifyNotConnected: 'Connect Spotify in settings',
    openOnIMDb: 'Open on IMDb',
    searchOnNetflix: 'Search on Netflix',
    searchOnPrimeVideo: 'Search on Prime Video',
    searchOnRaiPlay: 'Search on RaiPlay',
    searchOnNow: 'Search on NOW',
    searchOnDisneyPlus: 'Search on Disney+',
    searchOnAppleTv: 'Search on Apple TV',
    buyOnAmazon: 'Search on Amazon',
    searchOnGoogleBooks: 'Search on Google Books',
    by: 'by',
    director: 'Director',
    year: 'Year',

    // Settings
    settingsTitle: 'Settings',
    backToJournal: '← Back to Journal',
    spotify: 'Spotify',
    spotifyConnected: 'Connected',
    spotifyDisconnected: 'Not connected',
    spotifyHint: 'Connect your Spotify account to automatically add songs to a playlist.',
    connectSpotify: 'Connect Spotify',
    connecting: 'Connecting...',
    playlist: 'Playlist',

    // Features
    allowDuplicates: 'Allow duplicate URLs',
    allowDuplicatesDescription: 'Disable idempotency check. Allows analyzing the same URL multiple times (useful for testing).',
    shazamTitle: 'Shazam Recognition',
    shazamDescription: 'Use Shazam to recognize music in audio extracted from videos.',
    multiSongTitle: 'Multi-song scan',
    multiSongDescription: 'Segments audio with librosa to find multiple songs in a single video. Requires Shazam enabled.',
    youtubeDirectTitle: 'Direct YouTube link',
    youtubeDirectDescription: 'Resolves direct YouTube links via yt-dlp instead of generating generic search URLs.',
    carouselExtractionTitle: 'Carousel extraction',
    carouselExtractionDescription: 'Extracts songs and films from each slide of Instagram carousels with per-slide AI analysis.',

    // Language
    language: 'Language',
    languageDescription: 'Interface language and AI-generated text (summaries, slides, notes)',
    italian: 'Italiano',
    english: 'English',

    // Console
    debugConsole: 'Debug Console',
    home: 'Home',
    logs: 'logs',
    live: 'LIVE',
    clearLogs: 'Clear logs',
    confirmClearLogs: 'Are you sure you want to clear all logs?',
    noLogsFound: 'No logs found',
    loadingLogs: 'Loading logs...',
    level: 'Level',
    function: 'Function',
    search: 'Search...',
    all: 'All',
    data: 'Data',
    errorLabel: 'Error',

    // Prompts
    promptsTitle: 'AI Prompts',
    contentAnalysis: 'Content Analysis',
    telegramResponse: 'Telegram Response',
    enrichmentPrompt: 'OpenAI Enrichment',
    variables: 'Variables',
    availableVariables: 'Available variables',
    promptName: 'Prompt name',
    promptDescription: 'Description',
    save: 'Save',
    saving: 'Saving...',
    reset: 'Reset',
    resetDefault: 'Reset to default',
    resetConfirm: 'Are you sure you want to reset to the default template?',
    lastUpdated: 'Last updated',
    promptSaved: 'Prompt saved successfully!',
    promptReset: 'Prompt reset!',
    templateError: 'Template error',
    templateValid: 'Template valid',
    loadError: 'Error loading',
    saveError: 'Error saving',
    resetError: 'Error resetting',

    // Console additional
    entryId: 'Entry ID',
    allLevels: 'All',
    allFunctions: 'All',
    logsActivity: 'Activity',
    logsActor: 'Who',
    searchLogs: 'Search logs...',
    clearLogsError: 'Error clearing logs',

    // OpenAI Enrichment
    openaiSection: 'OpenAI Deep Search',
    openaiDescription: 'Use OpenAI with web search to enrich results with verified links. Requires an API key from platform.openai.com.',
    openaiApiKey: 'API Key',
    openaiSaveSuccess: 'OpenAI config saved!',
    openaiSaveError: 'Error saving OpenAI config',
    openaiHowTo: 'Go to platform.openai.com/api-keys to generate a key.',

    // Retry & Enrich
    retryEntry: 'Re-analyze',
    retrying: 'Re-analyzing...',
    enrichEntry: 'Enrich',
    enriching: 'Enriching...',
    enrichmentsSection: 'Deep Links',
    enrichError: 'Error during enrichment',
    retryError: 'Error during re-analysis',

    // Media Analysis & Auto-enrich
    transcription: 'Transcription',
    visualContext: 'Visual context',
    overlayText: 'Text in video',
    mediaAnalysis: 'Advanced media analysis',
    mediaAnalysisDescription: 'Downloads audio/video and analyzes them with AI for transcription, scene recognition, and overlay text.',
    mediaAnalysisPrompt: 'Media Analysis',
    pipelineFeatures: 'Pipeline',
    pageExtractionTitle: 'Web page extraction',
    pageExtractionDescription: 'For non-Instagram URLs (articles, blogs, social), extracts summary and links without downloading media.',

    aiAnalysisToggle: 'AI Analysis',
    aiAnalysisToggleDescription: 'Analyze content with AI to extract songs, films, notes, and tags.',
    transcriptionToggle: 'Audio transcription',
    transcriptionToggleDescription: 'Transcribes speech from audio using AI.',

    // Inspector
    selectEntry: 'Select an entry to explore details',
    selectEntryHint: 'Click a card on the left',
    openOriginal: 'Open original',
    copyUrl: 'Copy URL',
    shareEntry: 'Copy shareable link',
    urlCopied: 'URL copied!',
    transcript: 'Transcript',
    deepSearch: 'Deep Search',
    runDeepSearch: 'Enrich',
    timeAgo: 'ago',
    justNow: 'just now',
    minutesAgo: '{count}m ago',
    hoursAgo: '{count}h ago',
    yesterday: 'yesterday',
    daysAgo: '{count}d ago',
    back: '← Back',

    // Danger Zone
    dangerZone: 'Danger Zone',
    mfTitle: 'Music folders',
    mfIntro: 'The local files search reads Spooty’s folder and the extra folders you add here. They are read-only: the backend never changes them.',
    mfBuiltIn: 'Built-in',
    mfBuiltInNote: 'Always included, cannot be changed.',
    mfRoots: 'Allowed places (mounted in the container)',
    mfMountNote: 'To search other folders of the computer they must be mounted read-only in docker-compose.yml under MUSIC_EXTRA_ROOTS (usually /music-extra) and deployed: from here you can only pick folders that are already mounted.',
    mfNoExtra: 'No extra folders. Add one to search there too.',
    mfAdd: 'Add folder',
    mfRescan: 'Rescan now',
    mfLabelOf: 'Label of folder {path}',
    mfSwitchOf: 'Search in {label}',
    mfRemove: 'Remove',
    mfRemoveOf: 'Remove folder {label} from the list',
    mfRemoveHint: 'Takes the folder out of the search; the files are not touched.',
    mfStatusOk: 'ready',
    mfStatusScanning: 'scanning…',
    mfStatusPending: 'waiting to be scanned',
    mfStatusMissing: 'folder not found',
    mfStatusOff: 'off',
    mfFiles: '{n} files',
    mfFileOne: '1 file',
    mfTruncated: 'over the limit: some files are not indexed',
    mfScannedAt: 'last scan {time}',
    mfNeverScanned: 'never scanned',
    mfSaving: 'Saving…',
    mfLoading: 'Loading folders…',
    mfLoadError: 'Music folders unavailable',
    mfRetry: 'Try again',
    mfPickerTitle: 'Choose a folder',
    mfPickerRoots: 'Allowed places',
    mfPickerCurrent: 'Current folder',
    mfPickerHere: 'Add this folder',
    mfPickerUp: 'Up',
    mfPickerOpen: 'Open {name}',
    mfPickerAdd: 'Add {name}',
    mfPickerEmpty: 'No subfolders.',
    mfPickerNoRoots: 'No extra folder is mounted. Mount one in docker-compose.yml under MUSIC_EXTRA_ROOTS.',
    mfPickerLoading: 'Loading…',
    mfErrOutside: 'The folder is outside the allowed places (only folders mounted in the container).',
    mfErrMissing: 'The folder does not exist (or is not mounted in the container).',
    mfErrNotDir: 'The path is not a folder.',
    mfErrIncluded: 'This folder is already part of Spooty’s library: it is searched whole.',
    mfErrTooMany: 'Too many folders: the maximum is 20.',
    mfErrInvalid: 'Invalid path: an absolute path is needed.',
    mfErrForbidden: 'Only the admin can change the music folders.',
    mfErrNetwork: 'Server not reachable.',
    mfErrUnknown: 'The operation failed: {detail}',
    mfErrAt: '“{path}”: {message}',
    deleteAllDescription: 'Delete all entries from the database. This action cannot be undone.',

    // Errors
    errorGeneric: 'An error occurred',
    errorAnalysis: 'Error during analysis',
    errorDelete: 'Error deleting',
    errorSettings: 'Error updating settings',

    // Confirmations
    confirmDeleteAll: 'Are you sure you want to delete all {count} entries? This action cannot be undone.',
    deleted: 'Deleted {count} entries',

    // Recent section
    recentEntries: 'Today',
    filterToggle: 'Filter',
    seeAllJournal: 'Open full library →',
    inboxEmptyHint: 'Paste a link above, or open a recent card.',

    // Pagination & List Pages
    previousPage: '← Previous',
    nextPage: 'Next →',
    pageOf: 'Page {page} of {total}',
    allEntries: 'Link library',
    allSongs: 'All songs',
    allFilms: 'All films',
    allNotes: 'All notes',
    allSoftware: 'Software',
    noSoftwareYet: 'No software found yet',
    softwareTagSection: 'Tag',
    softwareTagRepo: 'Repo',
    softwareTagProduct: 'Product',
    softwareTagArticle: 'Article',
    softwareTagOther: 'Other',
    softwareOpenLink: 'Open',
    softwarePublished: 'Published',
    sortByTitle: 'Title',
    viewReel: 'View reel →',
    sortRecent: 'Recent',
    sortArtist: 'Artist A-Z',
    sortTitle: 'Title A-Z',
    sortFrequency: 'Most frequent',
    unknownArtist: 'Unknown artist',
    slidesSection: 'Carousel pages',
    slideCounter: 'Slide {n} / {total}',
    slideSuggestedLinks: 'Suggested links:',
    slideOcrText: 'Text extracted from this slide',
    openEntry: 'Open →',
    today: 'Today',
    noSongsYet: 'No songs found',
    libScopeLabel: 'Search in',
    libScopeSongs: 'Library',
    libScopeMedia: 'Media server',
    libScopeLocal: 'Local files',
    libScopeAll: 'Everything',
    libScopeTitle: 'Where to search: the library songs, the media server catalogue, the files on disk (Spooty’s folder and extra folders)',
    libMinChars: 'Type at least 2 characters to search the files.',
    libSearching: 'Searching…',
    libResultsLabel: 'Search results',
    libSummaryAll: 'Library {songs} · Media server {media} · Local files {local}',
    libSummaryOne: '{n} results in {scope}',
    libSummarySingle: '1 result in {scope}',
    libNone: 'No results for “{q}” in {scope}.',
    libElsewhere: 'Found elsewhere:',
    libNoSongsHere: 'No library song matches.',
    libShownOf: 'Showing the first {shown} of {total}',
    libInfoOnly: 'Search tells you where the songs are: finding them does not import them into the library, nor play them.',
    libInJournal: 'already in the library',
    libInJournalTitle: 'This song is already among the library songs',
    libCopyPath: 'path',
    libCopyUrl: 'URL',
    libErrForbidden: 'You are not allowed to search the files.',
    libErrNetwork: 'Server not reachable.',
    libErrServer: 'Search is not available right now.',
    libErrInvalid: 'Invalid search.',
    libRetry: 'Try again',
    noFilmsYet: 'No films found',
    noNotesYet: 'No notes found',

    searchPlaceholder: 'Search...',
    filtersButton: 'Filters',
    filtersReset: 'Reset',
    filtersTitle: 'Filters',
    genreSectionLabel: 'Genre',
    sortLabel: 'Sort by',
    sortByDate: 'Date',
    sortByMentions: 'Mentions',
    sortByDirector: 'Director',
    sortByArtist: 'Artist',

    filmsFilterAll: 'All',
    filmsFilterWatched: 'Watched',
    filmsFilterUnwatched: 'Unwatched',
    filmsFilterFree: 'Free',
    filmsFilterNotFree: 'Not free',
    filmsShelfLabel: 'Platform list',
    filmsShelfNetflix: 'Netflix',
    filmsShelfPrime: 'Prime',
    filmsShelfRaiPlay: 'RaiPlay',
    filmsOpenOnPlatform: 'Open on platform',
    filmsMentions: 'mentions',
    filmsMarkFresh: 'Fresh',
    filmsMarkRotten: 'Rotten',
    filmsMarkWatched: 'Mark as watched',
    filmsScorePlaceholder: '%',
    filmsAvailabilityHint: 'Availability: click the dot to cycle status',
    licensesTitle: 'Licenses and attributions',
    licensesDataProviders: 'Data providers',
    licensesOssTitle: 'Open source dependencies',
    licensesPackage: 'Package',
    licensesVersion: 'Version',
    licensesLicense: 'License',
    licensesLink: 'Licenses',
    filmsWatchedFilterLabel: 'Watched',
    filmsAvailabilityFilterLabel: 'Availability',
    filmsTmdbScore: 'TMDb score',
    filmsRefreshStreaming: 'Refresh availability',
    filmsStreamFree: 'Free',
    filmsStreamSub: 'Subscription',
    filmsStreamRent: 'Rental',
    filmsStreamBuy: 'Purchase',
    filmsArchiveBadge: 'Archive',
    filmsArchiveLookup: 'Search Internet Archive',
    filmsArchiveDownload: 'Download to archive',
    filmsArchiveDownloaded: 'Downloaded to archive',
    filmsArchiveNone: 'No public-domain copy found',

    songsFilterListened: 'Listened',
    songsFilterUnlistened: 'To listen',
    songsFilterFavorites: 'Favorites',
    songsFilterDownloaded: 'Downloaded',
    songsFilterNotDownloaded: 'Not downloaded',
    songsListenedFilterLabel: 'Listened',
    songsDownloadedFilterLabel: 'Downloaded',
    songsMarkLike: 'Like',
    songsMarkDislike: 'Dislike',
    songsMarkListened: 'Mark as listened',
    songsMarkFavorite: 'Favorite',
    songsMarkDownloaded: 'Downloaded (Spooty)',
    songsDownloadedLink: 'Downloaded — open the player',
    songsDownloadFile: 'Download MP3',
    songsOpenSpooty: 'Open Spooty',
    songsFileMissing: 'File not found in the music library',
    songsPreview: 'Preview',
    songsMentions: 'mentions',
    fromPost: 'From the post',
    versionOf: 'Version of',
    softwareOtherLinks: 'Other links',
    playerNav: 'Player',
    playerTitle: 'Player',
    playerOpen: '▶ Player',
    playerEmpty: 'No songs in this view',
    playerEmptyHint: 'Change filter — playback is via YouTube',
    playerFilterAll: 'All',
    playerFilterLiked: 'Liked',
    playerPreviewOnly: 'preview only',
    playerShuffle: 'Shuffle',
    playerRepeatOff: 'Repeat off',
    playerRepeatAll: 'Repeat all',
    playerRepeatOne: 'Repeat one',
    playerNowPlaying: 'Now playing',
    playerQueue: 'Queue',
    playerBrowseHint: 'Tap a track to set the queue',
    playlistsTitle: 'Playlists',
    playlistCreate: 'Create',
    playlistCreateNew: 'Create new',
    playlistNamePlaceholder: 'Playlist name…',
    playlistEmpty: 'No playlists yet — create one',
    playlistShowAll: 'Show all',
    playlistAddHint: 'Pick a playlist to add the song',
    playlistAddSong: 'Add to playlist',
    playlistRemoveSong: 'Remove from playlist',
    playlistRename: 'Rename',
    playlistDelete: 'Delete',
    playlistDeleteConfirm: 'Delete this playlist?',
    playlistSave: 'Save',
    playlistCancel: 'Cancel',
    playlistError: 'Playlist operation failed',
    playlistSearchPlaceholder: 'Search playlists',
    playlistFilterLabel: 'Show',
    playlistFilterAll: 'All',
    playlistFilterAuto: 'Automatic',
    playlistFilterMine: 'Mine',
    playlistFilterShared: 'Shared',
    playlistFilterDynamic: 'Dynamic',
    playlistSortLabel: 'Sort playlists by',
    playlistSortCreated: 'Date created',
    playlistSortUpdated: 'Last changed',
    playlistSortName: 'Name',
    playlistSortSize: 'Number of songs',
    playlistOrderDesc: 'Highest or newest first: tap to reverse',
    playlistOrderAsc: 'Lowest or oldest first: tap to reverse',
    playlistShowMore: 'Show more',
    playlistShownOf: '{shown} of {total}',
    playlistAutoBadge: 'automatic',
    playlistPanelShow: 'Show the list of playlists',
    playlistPanelHide: 'Hide the list of playlists',
    playlistNoMatch: 'No playlist matches',
    playlistPlay: '▶ Play',
    playlistActiveChip: 'Playlist',

    mgrTitle: 'Playlist manager',
    mgrHint: 'Tab switches pane · Space marks · F5 copy · F6 move · F8 remove · F1 help',
    mgrLibrary: 'All songs',
    mgrFileOnly: 'File only',
    playerShowing: 'Showing {shown} of {total}',
    playerShowMore: 'Show {n} more',
    mgrFileOnlyHint: 'Exists only as a file (geekom or the media server): it is in no journal post',
    mgrShowMore: 'Show {n} more',
    mgrShowing: 'Showing {shown} of {total}',
    mgrMine: 'My playlists',
    mgrSharedWithMe: 'Shared with me',
    mgrPaneA: 'Pane A',
    mgrPaneB: 'Pane B',
    mgrPanes: 'Panes',
    mgrLocationLabel: 'Pane content',
    mgrReload: 'Reload',
    mgrLoadError: 'Loading failed',
    mgrNoSongs: 'No songs match these filters',
    mgrEmptyPlaylist: 'Empty playlist — press F5 to copy songs here from the other pane',
    mgrItems: '{n} songs',
    mgrItemOne: '1 song',
    mgrMarked: '{n} marked',
    mgrOwnerYou: 'yours',
    mgrOwnerOf: 'by {name}',
    mgrReadOnly: 'read-only',
    mgrSharedWith: 'Shared with: {names}',
    mgrNotShared: 'Not shared',
    mgrMissingSong: 'not in your journal',
    mgrDownloaded: 'downloaded',
    mgrNotDownloaded: 'not downloaded',
    mgrPreparing: 'preparing',
    mgrFavorite: 'favorite',
    mgrFilters: 'Filters',
    mgrFilterText: 'Search title, artist, album…',
    mgrFilterArtist: 'Artist',
    mgrFilterAlbum: 'Album',
    mgrFilterType: 'Found by',
    mgrFilterSource: 'Source',
    mgrFilterGenre: 'Type (genre)',
    mgrFilterState: 'State',
    mgrFilterTags: 'Tags',
    mgrFilterYears: 'Years',
    mgrNoYear: 'No year',
    mgrFilterMembership: 'Versus the other pane',
    mgrMembershipAll: 'All',
    mgrMembershipIn: 'Already in the other playlist',
    mgrMembershipNotIn: 'Not yet in the other playlist',
    mgrFilterFavorites: 'Favorites only',
    mgrFilterListened: 'Listening',
    mgrFiltersReset: 'Reset filters',
    mgrStateAll: 'All',
    mgrSort: 'Sort',
    mgrTypeAudio: 'Audio recognition',
    mgrTypeAi: 'AI analysis',
    mgrTypeBoth: 'Audio + AI',
    mgrTypeList: 'List',
    mgrTypeSpotify: 'Spotify link',
    mgrTypeShazam: 'Shazam link',
    mgrFnBar: 'Commands',
    mgrFnHelp: 'Help',
    mgrFnDetails: 'Details',
    mgrFnRename: 'Rename',
    mgrFnCopy: 'Copy',
    mgrFnMove: 'Move',
    mgrFnNew: 'New',
    mgrFnRemove: 'Remove',
    mgrFnShare: 'Share',
    mgrFnPlay: 'Play',
    mgrFnUndo: 'Undo',
    mgrWhyBusy: 'Operation in progress',
    mgrWhyNothing: 'No song selected',
    mgrWhyLibrary: 'Not available in “All songs”',
    mgrWhyReadOnly: 'Shared with you: read-only',
    mgrWhyNoTarget: 'Needs an editable playlist in the other pane',
    mgrWhySamePlaylist: 'Both panes show the same playlist',
    mgrWhyNotOwner: 'Only the owner can share it or change its rule',
    mgrWhyFiltered: 'Clear the filters to reorder',
    mgrWhyNotAuth: 'Sign in to share',
    mgrWhyNoUndo: 'Nothing to undo',
    mgrProgress: '{op} {done}/{total}…',
    mgrOpCopy: 'Copy',
    mgrOpMove: 'Move',
    mgrOpRemove: 'Remove',
    mgrOpUndo: 'Undo',
    mgrResAdded: '{n} added',
    mgrResAlready: '{n} already there',
    mgrResRemoved: '{n} removed',
    mgrResFailed: '{n} failed',
    mgrResNotTried: '{n} not attempted (run aborted)',
    mgrResNothing: 'Nothing to do',
    mgrResDetails: 'Details',
    mgrResHide: 'Hide',
    mgrResRetry: 'Retry the failures',
    mgrResUndo: 'Undo',
    mgrResUndone: 'Operation undone',
    mgrResDismiss: 'Dismiss',
    mgrResStepAdd: 'add',
    mgrResStepRemove: 'remove',
    mgrResStepReorder: 'order',
    mgrReorderFailed: 'Reorder failed: {error}',
    mgrNewTitle: 'New playlist',
    mgrNewPlaceholder: 'Playlist name',
    mgrNewDone: 'Playlist “{name}” created (empty)',
    mgrRenameTitle: 'Rename playlist',
    mgrRenameDone: 'Playlist renamed',
    mgrRemoveTitle: 'Remove from playlist',
    mgrRemoveConfirm: 'Remove {n} songs from “{name}”? They stay in the library.',
    mgrMarkTitle: 'Mark by text',
    mgrUnmarkTitle: 'Unmark by text',
    mgrPatternHelp: 'Free text, or * and ? as wildcards (e.g. *live*)',
    mgrPatternPlaceholder: 'e.g. *live*',
    mgrShareTitle: 'Share “{name}”',
    mgrShareHint: 'Whoever receives it can see and play it, read-only.',
    mgrShareNobody: 'Nobody else to share with',
    mgrShareOwner: 'Owner: {name}',
    mgrShareLoading: 'Loading shares…',
    mgrShareError: 'Sharing failed',
    mgrClose: 'Close',
    mgrConfirm: 'Confirm',
    mgrDetailsTitle: 'Song details',
    mgrDetailsAlbum: 'Album',
    mgrDetailsGenres: 'Genres',
    mgrDetailsType: 'Type',
    mgrDetailsSource: 'Source',
    mgrDetailsTags: 'Tags',
    mgrDetailsMentions: 'Journal mentions',
    mgrDetailsFile: 'File',
    mgrDetailsFilePresent: 'MP3 on the server',
    mgrDetailsFileMissing: 'no MP3 on the server (the download starts on first play)',
    mgrShowPaths: 'Show paths',
    mgrShowPathsHint: 'Under each song: where the file is (disk, media server) or the YouTube link',
    mgrDetailsWhere: 'Location',
    mgrWhereFs: 'geekom disk (FS)',
    mgrWhereMs: 'Media server (MS)',
    mgrWhereYoutube: 'YouTube',
    mgrWhereNone: 'not there',
    mgrWhereNoPath: 'path not reported by the server',
    mgrWhereSearch: 'search: the video is not known yet',
    mgrCopy: 'Copy',
    mgrCopied: 'Copied',
    mgrCopyFailed: 'Copy failed',
    mgrCopyWhat: 'Copy {what}',
    mgrDetailsOpen: 'Open',
    mgrDetailsPlaceholder: 'Song of a shared playlist: it is not in your journal, so it cannot be played from here.',
    mgrCannotPlay: 'Cannot be played from here (not in your journal)',
    mgrHelpTitle: 'Keyboard shortcuts',
    mgrFnDynamic: 'Dynamic',
    mgrFnRule: 'Rule',
    mgrWhyDynamic: 'Dynamic playlist: the rule picks the songs (change the rule, not the songs)',
    mgrWhyNotDynamic: 'Only dynamic playlists have a rule',
    mgrDynamicPill: 'dynamic',
    mgrDynamicEvaluated: 'evaluated at {time}',
    mgrDynamicRefresh: 'Recalculate',
    mgrDynamicNever: 'not evaluated yet',
    mgrRuleCreated: 'Dynamic playlist “{name}” created: {n} songs',
    mgrRuleUpdated: 'Rule updated: {n} songs',
    dynTitleNew: 'New dynamic playlist',
    dynTitleEdit: 'Rule of “{name}”',
    dynIntro: 'Recalculated on every request (and every Sync): the songs follow your listening. Songs are not added or removed by hand.',
    dynPresetNone: 'Start from a preset…',
    dynPreset: 'Preset',
    dynName: 'Name',
    dynNameFixed: 'The name of a dynamic playlist cannot be changed.',
    dynScope: 'Whose listening',
    dynScopeMe: 'Only mine',
    dynScopeFamily: 'The whole family',
    dynPeriod: 'Period',
    dynPeriodDays: 'last {n} days',
    dynPeriodAll: 'all time',
    dynWindowEnable: 'Only listening within a time window',
    dynFrom: 'From',
    dynTo: 'To',
    dynWindowLocal: 'Local time of the listening (not the server’s).',
    dynCrossesMidnight: 'Crosses midnight: from {from} in the evening to {to} the next day.',
    dynWindowIgnored: 'The time window does not apply to never-played songs.',
    dynDays: 'Days',
    dynDaysAll: 'None picked = every day',
    dynDaysShort: [
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ],
    dynDaysLong: [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ],
    dynGenres: 'Type (genre)',
    dynGenresHint: 'None picked = every genre',
    dynOrder: 'Order',
    dynOrderMost: 'Most played',
    dynOrderLeast: 'Least played',
    dynOrderRecent: 'Recently played',
    dynOrderNever: 'Never played',
    dynOrderNewest: 'Recently added',
    dynNewestNote: 'This rule looks at the library, not at what was heard: period, time window, family and the minimum of plays do not count. It takes every song with the chosen genre, the newest first.',
    dynLimit: 'Maximum songs (1–200)',
    dynMinPlays: 'Minimum plays',
    dynDownloadedOnly: 'Downloaded songs only',
    dynSummary: 'Summary',
    dynMax: 'max {n}',
    dynFamily: 'family',
    dynDownloadedShort: 'downloaded only',
    dynMidnightShort: 'past midnight',
    dynIssueNameRequired: 'A name is required.',
    dynIssueNameLong: 'The name is too long (80 characters max).',
    dynIssueLimit: 'The maximum number of songs is 1 to 200.',
    dynIssueMinPlays: 'Minimum plays is a whole number, 0 or more.',
    dynIssueWindowTime: 'The times are not valid (HH:MM).',
    dynIssueWindowEmpty: 'Start and end are the same: the window would be empty.',
    dynCreate: 'Create the playlist',
    dynSave: 'Save the rule',
    statsNav: 'Statistics',
    statsTitle: 'Listening statistics',
    statsSubtitleMe: 'Your listening',
    statsSubtitleAll: 'Everybody’s listening',
    statsSubtitleUser: 'Listening of {user}',
    statsPeriod: 'Period',
    statsPeriodDays: '{n} days',
    statsPeriodAll: 'All time',
    statsScope: 'Listening of',
    statsScopeMe: 'Only mine',
    statsScopeAll: 'Everybody',
    statsUser: 'User',
    statsAllUsers: 'All users',
    statsDevice: 'Device',
    statsAllDevices: 'All devices',
    statsReload: 'Refresh',
    statsLoading: 'Loading statistics…',
    statsError: 'Statistics unavailable',
    statsEmptyTitle: 'No listening recorded yet',
    statsEmptyBody: 'Listening is recorded from the web player and from Mondrop. Play a few songs (at least 3 seconds) and come back: a play counts at 30 seconds or half the song, anything shorter is a skip.',
    statsEmptyNever: 'Library songs never played: {n}',
    statsTotals: 'Totals',
    statsPlays: 'Plays',
    statsSkips: 'Skips',
    statsListened: 'Time listened',
    statsSongs: 'Distinct songs',
    statsArtists: 'Distinct artists',
    statsDevices: 'Devices',
    statsNeverPlayed: 'Never played',
    statsNeverPlayedHint: 'library songs',
    statsPerDay: 'Plays per day',
    statsPerDaySummary: 'Plays per day: {days} days, {plays} plays in total, the busiest day has {max}.',
    statsDayTip: '{day}: {plays} plays, {time}',
    statsHeatmap: 'When you listen (local hour)',
    statsHeatmapSummary: 'Plays by weekday and local hour. Peak: {day} at {hour}, {n} plays.',
    statsHeatmapNone: 'Plays by weekday and local hour: no plays.',
    statsHeatmapTip: '{day} {hour}: {n} plays',
    statsTopSongs: 'Most played songs',
    statsTopArtists: 'Most played artists',
    statsTopGenres: 'Most played types (genres)',
    statsPerDevice: 'By device',
    statsPerOrigin: 'By origin',
    statsOriginLocal: 'On the phone (downloaded file)',
    statsOriginStream: 'Streamed from the server',
    statsOriginWeb: 'Web player',
    statsRankEmpty: 'No data in this period',
    statsPlaysCount: '{n} plays',
    statsPlaysOne: '1 play',
    statsRecent: 'Recent plays',
    statsColWhen: 'When',
    statsColSong: 'Song',
    statsColUser: 'User',
    statsColDevice: 'Device',
    statsColListened: 'Listened',
    statsColCounts: 'Result',
    statsCounted: 'counted',
    statsSkipped: 'skip',
    statsTable: 'Data table',
    statsColDay: 'Day',
    playerDlRequesting: 'requesting the download…',
    playerDlDownloading: 'downloading in parallel…',
    playerDlReady: 'downloaded — next time it plays from the file',
    playerDlFailed: 'download failed',
    playerDlUnavailable: 'no source found',
    playerDlTimeout: 'still being prepared',
    locFs: 'File on geekom’s disk (server)',
    locMs: 'On the media server (Fritz)',
    locFsMs: 'On geekom’s disk and on the media server',
    locYoutube: 'Streaming: YouTube link',
    sourceLabel: 'Source',
    sourceAuto: 'Auto',
    sourceInternet: 'Internet',
    sourceMedia: 'Media server',
    sourceAutoTitle: 'Automatic: on the home network it plays from the media server, from the internet it plays from Internet (YouTube)',
    sourceInternetTitle: 'Always from Internet (YouTube): the video replaces the cover',
    sourceMediaTitle: 'The file at home, streamed through the server (also from the internet). If the song is not there it plays from Internet and the download starts',
    sourceHintInternal: 'Auto: home network → media server',
    sourceHintExternal: 'Auto: from the internet → Internet',
    sourceHintFailed: 'Auto: network not detected → Internet',
    sourceNextSong: 'Applies from the next song',
    sourcePlayingFrom: 'Playing from',
    sourceFromMedia: 'Media server',
    sourceFromDisk: 'Home disk',
    sourceFromYoutube: 'Internet (YouTube)',
    playerVideoTitle: 'Video: {title} — {artist}',
    playerVideoIdle: 'Video of the song being played',
    playerWindowStatus: '{shown} of {total}',
    playerWindowHidden: '{n} already played hidden',
    playerWindowHiddenOne: '1 already played hidden',
    playerLoading: 'Loading…',
    chOpen: 'Choose what to play',
    chSearchLabel: 'Search songs',
    chPlaylist: 'Playlist',
    chAllSongs: 'All songs',
    chGenre: 'Type',
    chYears: 'Years',
    chNoYear: 'No year',
    chAlbum: 'Album',
    chArtist: 'Artist',
    chMoreOf: 'More ({n})…',
    chMoreLabel: 'More values: {legend}',
    chMoreFilters: 'More filters',
    chSource: 'Source',
    chTags: 'Tags',
    chDownloaded: 'Downloaded',
    chDlAll: 'All',
    chDlYes: 'Downloaded',
    chDlNo: 'Not downloaded',
    chWhere: 'Where it is',
    chFavorites: 'Favorites only',
    chNone: 'No song matches these filters.',
    chPlay: 'Play',
    chShuffle: 'Shuffle and play',
    chReset: 'Reset filters',
    chQueueSearch: 'Search: {q}',
    chShowAll: 'Show all ({n})',
    chShowLess: 'Show less',
    chActive: '{n} active filters',
    chOf: 'of {n}',
    chHint: 'Filters add up; inside one filter you can pick several. The result becomes the queue.',
    mgrHelpLines: [
      'Tab — switch to the other pane (Shift+Tab leaves the list)',
      '↑ ↓ Home End PgUp PgDn — move the cursor',
      'Space / Ins — mark and move down · + mark by text · - unmark · * invert · Ctrl+A all',
      'Enter — play · F3 — details',
      'F4 rename · F5 copy to the other pane · F6 move · F7 new playlist · F8 (or Del) remove · F9 share',
      'Ctrl+↑ / Ctrl+↓ — reorder inside the playlist · Ctrl+Z undoes the last operation',
      'F2 new dynamic playlist (rule: time window, days, period, type, order) · F4 on a dynamic one edits its rule',
      'Esc — closes, clears the marks, then jumps to the command bar',
    ],

    notesMentions: 'mentions',
    categorySectionLabel: 'Category',
    noteCategoryPlace: 'Place',
    noteCategoryEvent: 'Event',
    noteCategoryBrand: 'Brand',
    noteCategoryBook: 'Book',
    noteCategoryProduct: 'Product',
    noteCategoryQuote: 'Quote',
    noteCategoryPerson: 'Person',
    noteCategoryOther: 'Other',
  }
};

export function getBrowserLanguage(): Language {
  const browserLang = navigator.language.split('-')[0];
  return browserLang === 'it' ? 'it' : 'en';
}

export function getStoredLanguage(): Language | null {
  const stored = localStorage.getItem('soundreel-language');
  if (stored === 'it' || stored === 'en') {
    return stored;
  }
  return null;
}

export function setStoredLanguage(lang: Language): void {
  localStorage.setItem('soundreel-language', lang);
}
