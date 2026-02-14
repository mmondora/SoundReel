export type Language = 'it' | 'en';

export interface Translations {
  // Header
  entries: string;
  songs: string;
  films: string;
  notes: string;
  deleteAll: string;
  deleting: string;
  console: string;
  aiPrompts: string;
  settings: string;

  // Home
  inputPlaceholder: string;
  analyze: string;
  analyzing: string;
  urlAlreadyAnalyzed: string;
  analysisComplete: string;

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
  openOnIMDb: string;
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
  audioExtraction: string;
  cobaltTitle: string;
  cobaltDescription: string;
  cobaltWarning: string;
  allowDuplicates: string;
  allowDuplicatesDescription: string;

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
  loadError: string;
  saveError: string;
  resetError: string;

  // Console additional
  entryId: string;
  allLevels: string;
  allFunctions: string;
  searchLogs: string;
  clearLogsError: string;

  // Errors
  errorGeneric: string;
  errorAnalysis: string;
  errorDelete: string;
  errorSettings: string;

  // Confirmations
  confirmDeleteAll: string;
  deleted: string;
}

export const translations: Record<Language, Translations> = {
  it: {
    // Header
    entries: 'entries',
    songs: 'canzoni',
    films: 'film',
    notes: 'note',
    deleteAll: 'Cancella tutto',
    deleting: 'Eliminazione...',
    console: 'Console',
    aiPrompts: 'Prompt AI',
    settings: 'Impostazioni',

    // Home
    inputPlaceholder: 'Incolla un link da Instagram, TikTok, YouTube...',
    analyze: 'Analizza',
    analyzing: 'Analisi...',
    urlAlreadyAnalyzed: 'URL già analizzato in precedenza',
    analysisComplete: 'Analisi completata!',

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
    openOnIMDb: 'Apri su IMDb',
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
    audioExtraction: 'Estrazione Audio',
    cobaltTitle: 'Cobalt.tools',
    cobaltDescription: 'Estrae l\'audio dai video per il riconoscimento musicale tramite AudD. Richiede autenticazione API.',
    cobaltWarning: 'Cobalt potrebbe non funzionare con l\'API pubblica. Considera self-hosting.',
    allowDuplicates: 'Ammetti URL duplicati',
    allowDuplicatesDescription: 'Disabilita il controllo di idempotenza. Permette di analizzare lo stesso URL più volte (utile per test).',

    // Language
    language: 'Lingua',
    languageDescription: 'Seleziona la lingua dell\'interfaccia',
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
    loadError: 'Errore nel caricamento',
    saveError: 'Errore nel salvataggio',
    resetError: 'Errore nel reset',

    // Console additional
    entryId: 'Entry ID',
    allLevels: 'Tutti',
    allFunctions: 'Tutte',
    searchLogs: 'Cerca nei log...',
    clearLogsError: 'Errore durante la cancellazione dei log',

    // Errors
    errorGeneric: 'Si è verificato un errore',
    errorAnalysis: 'Errore durante l\'analisi',
    errorDelete: 'Errore durante l\'eliminazione',
    errorSettings: 'Errore durante l\'aggiornamento delle impostazioni',

    // Confirmations
    confirmDeleteAll: 'Sei sicuro di voler eliminare tutte le {count} entry? Questa azione non può essere annullata.',
    deleted: 'Eliminate {count} entry',
  },

  en: {
    // Header
    entries: 'entries',
    songs: 'songs',
    films: 'films',
    notes: 'notes',
    deleteAll: 'Delete all',
    deleting: 'Deleting...',
    console: 'Console',
    aiPrompts: 'AI Prompts',
    settings: 'Settings',

    // Home
    inputPlaceholder: 'Paste a link from Instagram, TikTok, YouTube...',
    analyze: 'Analyze',
    analyzing: 'Analyzing...',
    urlAlreadyAnalyzed: 'URL already analyzed',
    analysisComplete: 'Analysis complete!',

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
    openOnIMDb: 'Open on IMDb',
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
    audioExtraction: 'Audio Extraction',
    cobaltTitle: 'Cobalt.tools',
    cobaltDescription: 'Extracts audio from videos for music recognition via AudD. Requires API authentication.',
    cobaltWarning: 'Cobalt may not work with the public API. Consider self-hosting.',
    allowDuplicates: 'Allow duplicate URLs',
    allowDuplicatesDescription: 'Disable idempotency check. Allows analyzing the same URL multiple times (useful for testing).',

    // Language
    language: 'Language',
    languageDescription: 'Select the interface language',
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
    loadError: 'Error loading',
    saveError: 'Error saving',
    resetError: 'Error resetting',

    // Console additional
    entryId: 'Entry ID',
    allLevels: 'All',
    allFunctions: 'All',
    searchLogs: 'Search logs...',
    clearLogsError: 'Error clearing logs',

    // Errors
    errorGeneric: 'An error occurred',
    errorAnalysis: 'Error during analysis',
    errorDelete: 'Error deleting',
    errorSettings: 'Error updating settings',

    // Confirmations
    confirmDeleteAll: 'Are you sure you want to delete all {count} entries? This action cannot be undone.',
    deleted: 'Deleted {count} entries',
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
