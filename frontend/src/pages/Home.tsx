import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UrlInput } from '../components/UrlInput';
import { EntriesView } from '../components/EntriesView';
import { EntryInspector } from '../components/EntryInspector';
import { PageNav } from '../components/PageNav';
import { ViewSwitch } from '../components/views/ViewSwitch';
import { Wall } from '../components/views/Wall';
import { HomeSections } from '../components/views/HomeSections';
import { DetailPanel } from '../components/views/DetailPanel';
import { postFromSearch } from '../components/views/postCard';
import { usePageView } from '../hooks/useUiPrefs';
import { useEntryById } from '../hooks/useEntryById';
import { useInbox } from '../hooks/useInbox';
import { useSearch } from '../hooks/useSearch';
import { useAnalyze } from '../hooks/useAnalyze';
import { interpolate, useLanguage } from '../i18n';
import { CATEGORY_ICON, VERDICT_ICON } from '../utils/enrichmentVerdict';
import { pageFromParam } from '../utils/pageParam';
import type { InboxFilter, SearchResult, EnrichmentCategory, EnrichmentVerdictLabel } from '../types';

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
  const [filter, setFilter] = useState<InboxFilter>({});
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  // the page of the whole library the person is on, in the address (`?pagina=3`): the back button and a link to a page work
  const page = pageFromParam(searchParams.get('pagina'));
  const {
    entries, total, pageCount, loading: journalLoading, error: journalError, facets, version, reload,
  } = useInbox(page, filter);
  const { analyze, loading: analyzeLoading, error, successStatus, clearError } = useAnalyze();
  const { view, ready: viewReady } = usePageView('inbox');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [mobileInspector, setMobileInspector] = useState(false);
  /** Inbox First A: chip bar stays collapsed until the user opens Filtra. */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const q = searchParams.get('q') ?? '';
  const isSearchMode = q.trim().length >= 2;
  /** A search shows its results as cards in the Home view too: the sections have nothing to filter. */
  const effectiveView = view === 'home' && isSearchMode ? 'wall' : view;

  const { results: searchResults, expandedTerms, loading: searchLoading } = useSearch(q);

  const goToPage = useCallback((n: number, replace = false) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (n <= 1) next.delete('pagina');
      else next.set('pagina', String(n));
      return next;
    }, { replace });
  }, [setSearchParams]);

  // an address that asks for a page beyond the last one (a link that is old, a library that got smaller) lands on the last page there is
  useEffect(() => {
    if (!journalLoading && !journalError && page > pageCount) goToPage(pageCount, true);
  }, [journalLoading, journalError, page, pageCount, goToPage]);

  const hasFilter = Object.values(filter).some(Boolean);
  const clearFilters = useCallback(() => {
    setFilter({});
    goToPage(1, true);
  }, [goToPage]);
  /** A filter is the server's to apply on the whole library: a different one starts again from the first page. */
  const toggleFilter = useCallback((key: keyof InboxFilter, value: string) => {
    setFilter((prev) => ({ ...prev, [key]: prev[key] === value ? null : value }));
    goToPage(1, true);
  }, [goToPage]);

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

  // The post that is open is read by its id (the list holds summaries): a deep link to a post on another page, a post of the search, a post of the
  // sections. In the list views the list reads it itself (EntriesView), so it is not read twice. It is read again when the library changes.
  const listShowsIt = !isSearchMode && (effectiveView === 'studio' || effectiveView === 'wall');
  const { entry: selectedEntry } = useEntryById(listShowsIt ? null : selectedEntryId, undefined, version);

  const handleSubmit = async (url: string) => {
    clearError();
    const entryId = await analyze(url);
    if (entryId) {
      setSelectedEntryId(entryId);
      goToPage(1, true);    // the new post arrives at the top of the first page
    }
  };

  const handleSelect = useCallback((id: string | null) => {
    setSelectedEntryId(id);
    if (id && window.innerWidth < 768) {
      setMobileInspector(true);
    }
  }, []);

  const handleMobileBack = useCallback(() => {
    setMobileInspector(false);
  }, []);

  /** The detail panel closes: no selection, and a `?entry=` link does not bring it back. */
  const closeDetail = useCallback(() => {
    setSelectedEntryId(null);
    setMobileInspector(false);
    if (searchParams.get('entry')) {
      const next = new URLSearchParams(searchParams);
      next.delete('entry');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  /** A post of the list that is selected, or none: a deep link that was closed leaves the address too. */
  const selectInList = useCallback((id: string | null) => {
    if (id === null) closeDetail();
    else handleSelect(id);
  }, [closeDetail, handleSelect]);

  const showFilterBar =
    !isSearchMode &&
    effectiveView !== 'home' &&
    facets !== null &&
    (facets.platforms.length > 1 ||
      facets.channels.length > 1 ||
      facets.categories.length > 0 ||
      facets.verdicts.length > 0 ||
      facets.users.length > 1 ||
      facets.tags.length > 0);
  const filtersVisible = filtersOpen || hasFilter;

  /** «N risultati per …» (and the terms the search added): the same line over the list of the Studio and over the wall. */
  const searchStatus = (
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
  );

  const pager = <PageNav page={page} pageCount={pageCount} onPage={(n) => goToPage(n)} />;

  return (
    <div className="home home--inbox">

      <div className="url-input-bar inbox-input-bar">
        <UrlInput
          onSubmit={handleSubmit}
          loading={analyzeLoading}
          error={error}
          successStatus={successStatus}
        />
      </div>

      <div className="inbox-filter-row">
        <div className="inbox-toolbar">
          {showFilterBar && (
            <button
              type="button"
              className={`inbox-filter-toggle ${filtersVisible ? 'open' : ''} ${hasFilter ? 'active' : ''}`}
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersVisible}
            >
              {t.filterToggle}
              {hasFilter ? ` · ${total}` : ''}
            </button>
          )}
          {!isSearchMode && effectiveView !== 'home' && !journalLoading && !journalError && (
            <span className="inbox-count">{interpolate(t.inboxCount, { total })}</span>
          )}
          <ViewSwitch page="inbox" />
        </div>
        {showFilterBar && filtersVisible && facets && (
            <div className="journal-filter-bar inbox-filter-bar">
              <button
                className={`filter-chip ${!hasFilter ? 'active' : ''}`}
                onClick={clearFilters}
              >
                Tutti
              </button>
              {facets.platforms.map(({ platform, count }) => (
                <button
                  key={platform}
                  className={`filter-chip ${filter.platform === platform ? 'active' : ''}`}
                  onClick={() => toggleFilter('platform', platform)}
                  title={platform}
                >
                  {PLATFORM_LABEL[platform] ?? platform}
                  <span className="filter-chip-count"> {count}</span>
                </button>
              ))}
              {facets.channels.length > 1 && (
                <>
                  <span className="filter-divider" />
                  {facets.channels.map(({ channel, count }) => (
                    <button
                      key={channel}
                      className={`filter-chip ${filter.channel === channel ? 'active' : ''}`}
                      onClick={() => toggleFilter('channel', channel)}
                    >
                      {CHANNEL_LABEL[channel] ?? channel}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {facets.users.length > 1 && (
                <>
                  <span className="filter-divider" />
                  {facets.users.map(({ user, count }) => (
                    <button
                      key={user}
                      className={`filter-chip ${filter.user === user ? 'active' : ''}`}
                      onClick={() => toggleFilter('user', user)}
                    >
                      {user}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {facets.categories.length > 0 && (
                <>
                  <span className="filter-divider" />
                  {facets.categories.map(({ category, count }) => (
                    <button
                      key={category}
                      className={`filter-chip ${filter.category === category ? 'active' : ''}`}
                      onClick={() => toggleFilter('category', category)}
                    >
                      {CATEGORY_ICON[category as EnrichmentCategory] ?? ''} {CATEGORY_LABEL[category as EnrichmentCategory] ?? category}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {facets.verdicts.length > 0 && (
                <>
                  <span className="filter-divider" />
                  {facets.verdicts.map(({ verdict, count }) => (
                    <button
                      key={verdict}
                      className={`filter-chip ${filter.verdict === verdict ? 'active' : ''}`}
                      onClick={() => toggleFilter('verdict', verdict)}
                    >
                      {VERDICT_ICON[verdict as EnrichmentVerdictLabel]} {verdict.toUpperCase()}
                      <span className="filter-chip-count"> {count}</span>
                    </button>
                  ))}
                </>
              )}
              {facets.tags.length > 0 && (
                <>
                  <span className="filter-divider" />
                  {facets.tags.slice(0, 24).map(({ tag, count }) => (
                    <button
                      key={tag}
                      className={`filter-chip ${filter.tag === tag ? 'active' : ''}`}
                      onClick={() => toggleFilter('tag', tag)}
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

      {!viewReady ? (
        <div className="journal-loading">
          <span className="spinner" />
          <p>{t.loading}</p>
        </div>
      ) : effectiveView === 'home' ? (
        <main className="wall-layout home-layout">
          <div className="wall-scroll">
            <HomeSections selectedId={selectedEntryId} onOpenEntry={handleSelect} />
          </div>
          {selectedEntry && (
            <DetailPanel onClose={closeDetail}>
              <EntryInspector entry={selectedEntry} />
            </DetailPanel>
          )}
        </main>
      ) : isSearchMode && effectiveView === 'wall' ? (
        <main className="wall-layout">
          <div className="wall-scroll">
            {searchStatus}
            {!searchLoading && searchResults.length === 0 && (
              <div className="journal-empty">
                <p>Nessun risultato per &ldquo;{q}&rdquo;</p>
              </div>
            )}
            <Wall posts={searchResults.map(postFromSearch)} selectedId={selectedEntryId} onSelect={handleSelect} />
          </div>
          {selectedEntry && (
            <DetailPanel onClose={closeDetail}>
              <EntryInspector entry={selectedEntry} />
            </DetailPanel>
          )}
        </main>
      ) : isSearchMode ? (
        <main className={`master-detail ${!selectedEntry ? 'no-selection' : ''}`}>
          <div className={`journal-panel ${mobileInspector ? 'mobile-hidden' : ''}`}>
            <div className="journal-list">
              {searchStatus}
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
                  onSelect={handleSelect}
                />
              ))}
            </div>
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
      ) : journalLoading && entries.length === 0 ? (
        <div className="journal-loading">
          <span className="spinner" />
          <p>{t.loading}</p>
        </div>
      ) : journalError ? (
        <div className="home-error" role="alert">
          <p>{t.inboxLoadError}</p>
          <button type="button" onClick={reload}>{t.libRetry}</button>
        </div>
      ) : entries.length === 0 ? (
        <div className="journal-empty">
          <p>{hasFilter ? t.inboxNoMatch : t.noEntries}</p>
          {!hasFilter && <p>{t.noEntriesHint}</p>}
          {hasFilter && <button type="button" className="library-load-btn" onClick={clearFilters}>{t.inboxClearFilters}</button>}
        </div>
      ) : (
        <EntriesView
          entries={entries}
          mode={effectiveView === 'wall' ? 'wall' : 'studio'}
          selectedId={selectedEntryId}
          onSelect={selectInList}
          onDeleted={() => { setSelectedEntryId(null); reload(); }}
          scrollKey={page}
          version={version}
          footer={pager}
        />
      )}
    </div>
  );
}
