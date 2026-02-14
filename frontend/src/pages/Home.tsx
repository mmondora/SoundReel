import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/Header';
import { UrlInput } from '../components/UrlInput';
import { CompactCard } from '../components/CompactCard';
import { EntryInspector } from '../components/EntryInspector';
import { useJournal } from '../hooks/useJournal';
import { useAnalyze } from '../hooks/useAnalyze';
import { useLanguage } from '../i18n';
import type { Entry } from '../types';

export function Home() {
  const { entries, stats, loading: journalLoading } = useJournal();
  const { analyze, loading: analyzeLoading, error, successStatus, clearError } = useAnalyze();
  const { t } = useLanguage();
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [mobileInspector, setMobileInspector] = useState(false);

  // Find the selected entry from entries (keeps it fresh with real-time updates)
  const selectedEntry = entries.find(e => e.id === selectedEntryId) || null;

  // Auto-select new entry when analysis starts
  const handleSubmit = async (url: string) => {
    clearError();
    const entryId = await analyze(url);
    if (entryId) {
      setSelectedEntryId(entryId);
    }
  };

  // When entries update and selected entry was deleted, clear selection
  useEffect(() => {
    if (selectedEntryId && !entries.find(e => e.id === selectedEntryId)) {
      setSelectedEntryId(null);
      setMobileInspector(false);
    }
  }, [entries, selectedEntryId]);

  const handleSelect = useCallback((entry: Entry) => {
    setSelectedEntryId(entry.id);
    // On mobile, switch to inspector view
    if (window.innerWidth < 768) {
      setMobileInspector(true);
    }
  }, []);

  const handleMobileBack = useCallback(() => {
    setMobileInspector(false);
  }, []);

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

      <main className="master-detail">
        {/* Journal panel (left) - hidden on mobile when inspector is open */}
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
            <div className="journal-list">
              {entries.map(entry => (
                <CompactCard
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selectedEntryId}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          )}
        </div>

        {/* Inspector panel (right) */}
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
