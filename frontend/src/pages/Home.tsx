import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { UrlInput } from '../components/UrlInput';
import { CompactCard } from '../components/CompactCard';
import { EntryInspector } from '../components/EntryInspector';
import { useJournal } from '../hooks/useJournal';
import { useSearch } from '../hooks/useSearch';
import { useAnalyze } from '../hooks/useAnalyze';
import { useLanguage } from '../i18n';
import { getEntry } from '../services/api';
import { CATEGORY_ICON, VERDICT_ICON } from '../utils/enrichmentVerdict';
import type { Entry, SearchResult, EnrichmentCategory, EnrichmentVerdictLabel } from '../types';

const CATEGORY_LABEL: Record<EnrichmentCategory, string> = {
  tech: 'Tech',
  security: 'Sicurezza',
  claim: 'Claim',
  generic: 'Generico',
};

const PLATFORM_LABEL: Record<string, string> = {
  instagram: 'IG',
  youtube: 'YT',
  tiktok: 'TT',
  twitter: 'X',
  facebook: 'FB',
  threads: 'TH',
  reddit: 'RD',
  vimeo: 'VM',
  soundcloud: 'SC',
  twitch: 'TV',
  spotify: 'SP',
  shazam: 'SZ',
  linkedin: 'LI',
  pinterest: 'PIN',
  snapchat: 'SNAP',
  other: 'WEB',
};

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'TG',
  web: 'Web',
  ios: 'iOS',
};

function parseFirestoreDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'object' && timestamp !== null) {
    const ts = timestamp as Record<string, unknown>;
    const seconds = ts._seconds ?? ts.seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000);
  }
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

const RECENT_COUNT = 5;

function truncate(s: string | null, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

interface SearchResultRowProps {
  result: SearchResult;
  selected: boolean;
  onSelect: (id: string) => void;
}

function SearchResultRow({ result, selected, onSelect }: SearchResultRowProps) {
  const label = PLATFORM_LABEL[result.sourcePlatform] ?? 'WEB';
  const summary = result.results.summary ?? result.caption;
  const songCount = result.results.songs.length;
  const filmCount = result.results.films.length;
  const noteCount = result.results.notes.length;
  const parsedDate = parseFirestoreDate(result.createdAt);

  return (
    <div
      className={`compact-card ${selected ? 'selected' : ''} completed`}
      onClick={() => onSelect(result.id)}
    >
      {result.thumbnailUrl ? (
        <img src={result.thumbnailUrl} alt="" className="compact-thumb" loading="lazy" />
      ) : (
        <div className="compact-thumb-placeholder">{label}</div>
      )}
      <div className="compact-content">
        <div className="compact-top">
          <span className="compact-platform">{label}</span>
          {parsedDate && (
            <span className="compact-time">{parsedDate.toLocaleDateString()}</span>
          )}
        </div>
        <p className="compact-summary">{truncate(summary ?? result.sourceUrl, 100)}</p>
        <div className="compact-bottom">
          <div className="compact-counts">
            {songCount > 0 && <span className="compact-count">🎵 {songCount}</span>}
            {filmCount > 0 && <span className="compact-count">🎬 {filmCount}</span>}
            {noteCount > 0 && <span className="compact-count">📝 {noteCount}</span>}
            {result.results.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="compact-count">{tag}</span>
            ))}
          </div>
          <span className="compact-status completed">●</span>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  const [filterPlatform, setFilterPlatform] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState<string | null>(null);
  const [filterUser, setFilterUser] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterVerdict, setFilterVerdict] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const {
    entries, loading: journalLoading,
    availablePlatforms, availableChannels, availableUsers, availableCategories, availableVerdicts,
    availableTags, filteredCount,
  } = useJournal(20, {
    platform: filterPlatform, channel: filterChannel, user: filterUser,
    category: filterCategory, verdict: filterVerdict, tag: filterTag,
  });
  const { analyze, loading: analyzeLoading, error, successStatus, clearError } = useAnalyze();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [mobileInspector, setMobileInspector] = useState(false);
  /** Inbox First A: chip bar stays collapsed until the user opens Filtra. */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const q = searchParams.get('q') ?? '';
  const isSearchMode = q.trim().length >= 2;

  const { results: searchResults, expandedTerms, loading: searchLoading } = useSearch(q);

  const hasFilter = !!(filterPlatform || filterChannel || filterUser || filterCategory || filterVerdict || filterTag);
  const clearFilters = useCallback(() => {
    setFilterPlatform(null); setFilterChannel(null); setFilterUser(null);
    setFilterCategory(null); setFilterVerdict(null); setFilterTag(null);
  }, []);
  const togglePlatform = useCallback((p: string) => setFilterPlatform(prev => prev === p ? null : p), []);
  const toggleChannel = useCallback((ch: string) => setFilterChannel(prev => prev === ch ? null : ch), []);
  const toggleUser = useCallback((u: string) => setFilterUser(prev => prev === u ? null : u), []);
  const toggleCategory = useCallback((c: string) => setFilterCategory(prev => prev === c ? null : c), []);
  const toggleVerdict = useCallback((v: string) => setFilterVerdict(prev => prev === v ? null : v), []);
  const toggleTag = useCallback((tag: string) => setFilterTag(prev => prev === tag ? null : tag), []);

  // Auto-select from query param ?entry=id. On mobile this must also open
  // the inspector panel (CSS hides it behind `.mobile-visible` below 768px) —
  // the same condition handleSelect/handleSearchSelect use on click, since a
  // Telegram deep link never fires a click. Guarded by a ref keyed on the id
  // so the panel opens once per deep link: `searchParams` is a new object
  // whenever the URL's query string changes at all (e.g. the user starts a
  // search while the entry is open), which would otherwise re-run this
  // effect and reopen the panel after the user pressed "back".
  const mobileInspectorOpenedForRef = useRef<string | null>(null);
  useEffect(() => {
    const entryParam = searchParams.get('entry');
    if (entryParam) {
      setSelectedEntryId(entryParam);
      if (window.innerWidth < 768 && mobileInspectorOpenedForRef.current !== entryParam) {
        mobileInspectorOpenedForRef.current = entryParam;
        setMobileInspector(true);
      }
    }
  }, [searchParams]);

  const [selectedSearchEntry, setSelectedSearchEntry] = useState<Entry | null>(null);

  useEffect(() => {
    if (isSearchMode && selectedEntryId) {
      getEntry(selectedEntryId).then(setSelectedSearchEntry).catch(() => setSelectedSearchEntry(null));
    } else {
      setSelectedSearchEntry(null);
    }
  }, [isSearchMode, selectedEntryId]);

  // Fallback fetch for a journal-mode selection that isn't in the currently
  // loaded page — e.g. a Telegram deep link `?entry=<id>` pointing at an
  // entry older than the first page. Mirrors the getEntry-on-select shape
  // used above for search mode.
  const [fetchedEntry, setFetchedEntry] = useState<Entry | null>(null);
  const fetchedEntryIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isSearchMode || !selectedEntryId || entries.some(e => e.id === selectedEntryId)) {
      fetchedEntryIdRef.current = null;
      setFetchedEntry(null);
      return;
    }
    // Already attempted this id (success or failure) — don't refetch just
    // because `entries` got a new reference from an SSE-triggered reload.
    if (fetchedEntryIdRef.current === selectedEntryId) return;
    fetchedEntryIdRef.current = selectedEntryId;
    let cancelled = false;
    getEntry(selectedEntryId)
      .then((e) => { if (!cancelled) setFetchedEntry(e); })
      // Missing/deleted entry: fall back to no selection rather than a
      // spinner or an uncaught rejection.
      .catch(() => { if (!cancelled) setFetchedEntry(null); });
    return () => { cancelled = true; };
  }, [isSearchMode, selectedEntryId, entries]);

  const selectedEntry = isSearchMode
    ? selectedSearchEntry
    : (entries.find(e => e.id === selectedEntryId) || fetchedEntry);

  const handleSubmit = async (url: string) => {
    clearError();
    const entryId = await analyze(url);
    if (entryId) {
      setSelectedEntryId(entryId);
    }
  };

  useEffect(() => {
    if (selectedEntryId && !entries.find(e => e.id === selectedEntryId)) {
      // Don't clear if it's from a query param — entry might be on another page
      if (!searchParams.get('entry')) {
        setSelectedEntryId(null);
        setMobileInspector(false);
      }
    }
  }, [entries, selectedEntryId, searchParams]);

  const handleSelect = useCallback((entry: Entry) => {
    setSelectedEntryId(entry.id);
    if (window.innerWidth < 768) {
      setMobileInspector(true);
    }
  }, []);

  const handleSearchSelect = useCallback((id: string) => {
    setSelectedEntryId(id);
    if (window.innerWidth < 768) {
      setMobileInspector(true);
    }
  }, []);

  const handleMobileBack = useCallback(() => {
    setMobileInspector(false);
  }, []);

  const recentEntries = useMemo(() => entries.slice(0, RECENT_COUNT), [entries]);
  const listEntries = hasFilter ? entries : recentEntries;
  const showFilterBar =
    !isSearchMode &&
    (availablePlatforms.length > 1 ||
      availableChannels.length > 1 ||
      availableCategories.length > 0 ||
      availableVerdicts.length > 0 ||
      availableUsers.length > 1 ||
      availableTags.length > 0);
  const filtersVisible = filtersOpen || hasFilter;

  return (
    <div className="home home--inbox">
      <Header />

      <div className="url-input-bar inbox-input-bar">
        <UrlInput
          onSubmit={handleSubmit}
          loading={analyzeLoading}
          error={error}
          successStatus={successStatus}
          hero
        />
      </div>

      {showFilterBar && (
        <div className="inbox-filter-row">
          <button
            type="button"
            className={`inbox-filter-toggle ${filtersVisible ? 'open' : ''} ${hasFilter ? 'active' : ''}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersVisible}
          >
            {t.filterToggle}
            {hasFilter ? ` · ${filteredCount}` : ''}
          </button>
          {filtersVisible && (
            <div className="journal-filter-bar inbox-filter-bar">
              <button
                className={`filter-chip ${!hasFilter ? 'active' : ''}`}
                onClick={clearFilters}
              >
                Tutti
              </button>
              {availablePlatforms.map(({ platform, count }) => (
                <button
                  key={platform}
                  className={`filter-chip ${filterPlatform === platform ? 'active' : ''}`}
                  onClick={() => togglePlatform(platform)}
                  title={platform}
                >
                  {PLATFORM_LABEL[platform] ?? platform}
                  <span className="filter-chip-count"> {count}</span>
                </button>
              ))}
              {availableChannels.length > 1 && (
                <>
                  <span className="filter-divider" />
                  {availableChannels.map(({ channel, count }) => (
                    <button
                      key={channel}
                      className={`filter-chip ${filterChannel === channel ? 'active' : ''}`}
                      onClick={() => toggleChannel(channel)}
                    >
                      {CHANNEL_LABEL[channel] ?? channel}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {availableUsers.length > 1 && (
                <>
                  <span className="filter-divider" />
                  {availableUsers.map(({ user, count }) => (
                    <button
                      key={user}
                      className={`filter-chip ${filterUser === user ? 'active' : ''}`}
                      onClick={() => toggleUser(user)}
                    >
                      {user}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {availableCategories.length > 0 && (
                <>
                  <span className="filter-divider" />
                  {availableCategories.map(({ category, count }) => (
                    <button
                      key={category}
                      className={`filter-chip ${filterCategory === category ? 'active' : ''}`}
                      onClick={() => toggleCategory(category)}
                    >
                      {CATEGORY_ICON[category as EnrichmentCategory] ?? ''} {CATEGORY_LABEL[category as EnrichmentCategory] ?? category}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {availableVerdicts.length > 0 && (
                <>
                  <span className="filter-divider" />
                  {availableVerdicts.map(({ verdict, count }) => (
                    <button
                      key={verdict}
                      className={`filter-chip ${filterVerdict === verdict ? 'active' : ''}`}
                      onClick={() => toggleVerdict(verdict)}
                    >
                      {VERDICT_ICON[verdict as EnrichmentVerdictLabel]} {verdict.toUpperCase()}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {availableTags.length > 0 && (
                <>
                  <span className="filter-divider" />
                  {availableTags.slice(0, 24).map(({ tag, count }) => (
                    <button
                      key={tag}
                      className={`filter-chip ${filterTag === tag ? 'active' : ''}`}
                      onClick={() => toggleTag(tag)}
                      title={tag}
                    >
                      {tag}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      <main className={`master-detail ${!selectedEntry ? 'no-selection' : ''}`}>
        <div className={`journal-panel ${mobileInspector ? 'mobile-hidden' : ''}`}>
          {isSearchMode ? (
            <div className="journal-list">
              <div className="search-status">
                {searchLoading ? (
                  <span>Ricerca in corso…</span>
                ) : (
                  <span>{searchResults.length} risultati per &ldquo;{q}&rdquo;</span>
                )}
                {expandedTerms.length > 0 && (
                  <span className="search-expanded-terms">
                    Cercato anche: {expandedTerms.join(', ')}
                  </span>
                )}
              </div>
              {!searchLoading && searchResults.length === 0 && (
                <div className="journal-empty">
                  <p>Nessun risultato per &ldquo;{q}&rdquo;</p>
                </div>
              )}
              {searchResults.map((result) => (
                <SearchResultRow
                  key={result.id}
                  result={result}
                  selected={result.id === selectedEntryId}
                  onSelect={handleSearchSelect}
                />
              ))}
            </div>
          ) : journalLoading ? (
            <div className="journal-loading">
              <span className="spinner" />
              <p>{t.loading}</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="journal-empty">
              <p>{t.noEntries}</p>
              <p>{t.noEntriesHint}</p>
            </div>
          ) : (
            <div className="journal-list inbox-list">
              <div className="date-group-header">{hasFilter ? t.filtersButton : t.recentEntries}</div>
              {listEntries.map((entry) => (
                <CompactCard
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selectedEntryId}
                  onSelect={handleSelect}
                />
              ))}
              {!hasFilter && (
                <Link to="/entries" className="inbox-see-all">
                  {t.seeAllJournal}
                </Link>
              )}
            </div>
          )}
        </div>

        <div className={`inspector-panel ${mobileInspector ? 'mobile-visible' : ''} ${!selectedEntry ? 'empty' : ''}`}>
          {selectedEntry ? (
            <EntryInspector
              entry={selectedEntry}
              onBack={window.innerWidth < 768 ? handleMobileBack : undefined}
            />
          ) : (
            <div className="inspector-placeholder">
              <div className="inspector-placeholder-icon">📋</div>
              <p>{t.selectEntry}</p>
              <p className="inspector-placeholder-hint">{t.inboxEmptyHint}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
