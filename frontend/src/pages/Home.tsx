import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { UrlInput } from '../components/UrlInput';
import { CompactCard } from '../components/CompactCard';
import { EntryInspector } from '../components/EntryInspector';
import { Pagination } from '../components/Pagination';
import { useJournal } from '../hooks/useJournal';
import { useAnalyze } from '../hooks/useAnalyze';
import { useLanguage } from '../i18n';
import type { Entry } from '../types';

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

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

interface DateGroup {
  key: string;
  label: string;
  entries: Entry[];
}

const RECENT_COUNT = 5;

function groupByMonth(entries: Entry[], lang: string): DateGroup[] {
  const groups: DateGroup[] = [];
  let lastMonthKey = '';
  const locale = lang === 'it' ? 'it-IT' : 'en-US';

  for (const entry of entries) {
    const date = parseFirestoreDate(entry.createdAt);
    if (!date) {
      if (groups.length === 0) groups.push({ key: 'unknown', label: '', entries: [] });
      groups[groups.length - 1].entries.push(entry);
      continue;
    }

    const monthKey = getMonthKey(date);

    if (monthKey !== lastMonthKey) {
      const label = date.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
      groups.push({ key: monthKey, label, entries: [] });
      lastMonthKey = monthKey;
    }

    groups[groups.length - 1].entries.push(entry);
  }

  return groups;
}

export function Home() {
  const [filterPlatform, setFilterPlatform] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState<string | null>(null);

  const {
    entries, stats, loading: journalLoading,
    currentPage, totalPages, nextPage, prevPage,
    availablePlatforms, availableChannels, filteredCount,
  } = useJournal(20, { platform: filterPlatform, channel: filterChannel });
  const { analyze, loading: analyzeLoading, error, successStatus, clearError } = useAnalyze();
  const { t, language } = useLanguage();
  const [searchParams] = useSearchParams();
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [mobileInspector, setMobileInspector] = useState(false);

  const hasFilter = !!(filterPlatform || filterChannel);
  const clearFilters = useCallback(() => { setFilterPlatform(null); setFilterChannel(null); }, []);
  const togglePlatform = useCallback((p: string) => setFilterPlatform(prev => prev === p ? null : p), []);
  const toggleChannel = useCallback((ch: string) => setFilterChannel(prev => prev === ch ? null : ch), []);

  // Auto-select from query param ?entry=id
  useEffect(() => {
    const entryParam = searchParams.get('entry');
    if (entryParam) {
      setSelectedEntryId(entryParam);
    }
  }, [searchParams]);

  const selectedEntry = entries.find(e => e.id === selectedEntryId) || null;

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

  const handleMobileBack = useCallback(() => {
    setMobileInspector(false);
  }, []);

  const recentEntries = useMemo(() => entries.slice(0, RECENT_COUNT), [entries]);
  const archiveEntries = useMemo(() => entries.slice(RECENT_COUNT), [entries]);
  const archiveGroups = useMemo(
    () => groupByMonth(archiveEntries, language),
    [archiveEntries, language]
  );

  return (
    <div className="home">
      <Header stats={stats} />

      <div className="url-input-bar">
        <UrlInput
          onSubmit={handleSubmit}
          loading={analyzeLoading}
          error={error}
          successStatus={successStatus}
        />
      </div>

      {(availablePlatforms.length > 1 || availableChannels.length > 1) && (
        <div className="journal-filter-bar">
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
          {hasFilter && (
            <span className="filter-result-count">{filteredCount}</span>
          )}
        </div>
      )}

      <main className={`master-detail ${!selectedEntry ? 'no-selection' : ''}`}>
        <div className={`journal-panel ${mobileInspector ? 'mobile-hidden' : ''}`}>
          {journalLoading ? (
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
            <>
              <div className="journal-list">
                {recentEntries.length > 0 && (
                  <div>
                    <div className="date-group-header">{t.recentEntries}</div>
                    {recentEntries.map(entry => (
                      <CompactCard
                        key={entry.id}
                        entry={entry}
                        selected={entry.id === selectedEntryId}
                        onSelect={handleSelect}
                      />
                    ))}
                  </div>
                )}
                {archiveGroups.map(group => (
                  <div key={group.key}>
                    <div className="date-group-header">{group.label}</div>
                    {group.entries.map(entry => (
                      <CompactCard
                        key={entry.id}
                        entry={entry}
                        selected={entry.id === selectedEntryId}
                        onSelect={handleSelect}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPrev={prevPage}
                onNext={nextPage}
              />
            </>
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
              <p className="inspector-placeholder-hint">{t.selectEntryHint}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
