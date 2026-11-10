import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listEntrySummaries } from '../services/api';
import { useLanguage } from '../i18n';
import { EntryInspector } from '../components/EntryInspector';
import { DetailPanel } from '../components/views/DetailPanel';
import { ViewSwitch } from '../components/views/ViewSwitch';
import { Wall } from '../components/views/Wall';
import { postFromSummary } from '../components/views/postCard';
import { useEntryById } from '../hooks/useEntryById';
import { usePageView } from '../hooks/useUiPrefs';
import { platformLabel } from '../utils/platformLabel';
import type { EntrySummary } from '../types';

// The Link page: every post, newest first. Two views chosen by the user and kept on the server (look and feel P3): Studio (the list on the left,
// the post on the right: the default) and Bacheca (a wall of cards and a panel that closes). It lists summaries, so the post that is opened is
// read by its id.

const PAGE_SIZE = 40;

function parseDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

function formatDayLabel(date: Date, lang: string, today: string, yesterday: string): string {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return today;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return yesterday;
  return date.toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

interface RowProps {
  entry: EntrySummary;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** One post of the list. The whole row opens the post (a button laid over it, named by the summary); «Apri» still goes to the Inbox. */
function LibraryRow({ entry, selected, onSelect }: RowProps) {
  const { t, language } = useLanguage();
  const summaryId = useId();
  const date = parseDate(entry.createdAt);
  const summary = entry.summary || entry.caption?.substring(0, 140) || entry.sourceUrl;
  return (
    <li className={`library-row${selected ? ' selected' : ''}`}>
      <button
        type="button"
        className="library-row-hit"
        aria-pressed={selected}
        aria-labelledby={summaryId}
        onClick={() => onSelect(entry.id)}
      />
      {entry.thumbnailUrl ? (
        <img src={entry.thumbnailUrl} alt="" className="library-thumb" loading="lazy" />
      ) : (
        <div className="library-thumb-placeholder">{platformLabel(entry.sourcePlatform)}</div>
      )}
      <div className="library-row-body">
        <div className="library-row-meta">
          <span className="library-platform">{platformLabel(entry.sourcePlatform)}</span>
          {date && (
            <span className="library-time">
              {date.toLocaleTimeString(language === 'it' ? 'it-IT' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <p className="library-summary" id={summaryId}>{summary}</p>
        <div className="library-counts">
          {entry.songCount > 0 && <span>🎵 {entry.songCount}</span>}
          {entry.filmCount > 0 && <span>🎬 {entry.filmCount}</span>}
          {entry.noteCount > 0 && <span>📝 {entry.noteCount}</span>}
          {(entry.tags ?? []).slice(0, 4).map((tag) => (
            <span key={tag} className="library-tag">{tag}</span>
          ))}
        </div>
      </div>
      <Link to={`/?entry=${entry.id}`} className="library-open">
        {t.openEntry}
      </Link>
    </li>
  );
}

export function EntriesPage() {
  const { t, language } = useLanguage();
  const [searchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();
  const { view, ready: viewReady } = usePageView('links');

  const [items, setItems] = useState<EntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { entry: selectedEntry, loading: selectedLoading } = useEntryById(selectedId);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await listEntrySummaries(PAGE_SIZE, offset);
      setTotal(page.total);
      setItems((prev) => (append ? [...prev, ...page.entries] : page.entries));
    } catch (e) {
      console.error('[EntriesPage]', e);
      setError(t.error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t.error]);

  useEffect(() => {
    void loadPage(0, false);
  }, [loadPage]);

  const filtered = useMemo(() => {
    if (!q) return items;
    return items.filter((e) => {
      const tagHay = (e.tags ?? []).join(' ');
      const hay = `${e.summary ?? ''} ${e.caption ?? ''} ${e.sourceUrl} ${e.sourcePlatform} ${tagHay}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, q]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: EntrySummary[] }[] = [];
    let lastKey = '';
    for (const entry of filtered) {
      const date = parseDate(entry.createdAt);
      const key = date ? date.toDateString() : 'unknown';
      if (key !== lastKey) {
        out.push({
          key,
          label: date
            ? formatDayLabel(date, language, t.today, t.yesterday)
            : '',
          items: [],
        });
        lastKey = key;
      }
      out[out.length - 1].items.push(entry);
    }
    return out;
  }, [filtered, language, t.today, t.yesterday]);

  const posts = useMemo(() => filtered.map(postFromSummary), [filtered]);

  const closeDetail = useCallback(() => setSelectedId(null), []);

  /** The open post was deleted: out of the list, one less in the count, nothing open. */
  const onDeleted = useCallback(() => {
    setItems((prev) => prev.filter((e) => e.id !== selectedId));
    setTotal((n) => Math.max(0, n - 1));
    setSelectedId(null);
  }, [selectedId]);

  const hasMore = items.length < total && !q;
  const countLabel = t.entriesCountLabel
    .replace('{shown}', String(filtered.length))
    .replace('{total}', String(q ? filtered.length : total));

  const loadMore = hasMore && (
    <div className="library-load-more">
      <button
        type="button"
        className="library-load-btn"
        disabled={loadingMore}
        onClick={() => void loadPage(items.length, true)}
      >
        {loadingMore ? <span className="spinner" /> : t.loadMoreEntries}
      </button>
    </div>
  );

  const waiting = loading || !viewReady;

  return (
    <div className="list-page list-page--library links-page">
      <div className="list-page-content">
        <div className="list-page-header library-header">
          <div className="library-header-text">
            <Link to="/" className="list-page-back">{t.back}</Link>
            <h1>{t.allEntries}</h1>
            {!loading && (
              <p className="library-count">{countLabel}</p>
            )}
          </div>
          <ViewSwitch page="links" />
        </div>

        {waiting ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : error ? (
          <div className="list-page-empty">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="list-page-empty">{t.noEntries}</div>
        ) : view === 'wall' ? (
          <div className="wall-layout links-wall">
            <div className="wall-scroll">
              <Wall posts={posts} selectedId={selectedId} onSelect={setSelectedId} />
              {loadMore}
            </div>
            {selectedEntry && (
              <DetailPanel onClose={closeDetail}>
                <EntryInspector entry={selectedEntry} onDeleted={onDeleted} />
              </DetailPanel>
            )}
          </div>
        ) : (
          <div className={`links-split${selectedId ? ' has-selection' : ''}`}>
            <div className="links-list">
              <div className="library-list">
                {groups.map((group) => (
                  <section key={group.key} className="library-day">
                    {group.label && (
                      <h2 className="library-day-label">{group.label}</h2>
                    )}
                    <ul className="library-rows">
                      {group.items.map((entry) => (
                        <LibraryRow key={entry.id} entry={entry} selected={entry.id === selectedId} onSelect={setSelectedId} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              {loadMore}
            </div>
            <section className="links-detail">
              {selectedEntry ? (
                <EntryInspector
                  entry={selectedEntry}
                  onBack={window.innerWidth < 768 ? closeDetail : undefined}
                  onDeleted={onDeleted}
                />
              ) : selectedLoading ? (
                <div className="journal-loading">
                  <span className="spinner" />
                </div>
              ) : (
                <div className="inspector-placeholder">
                  <div className="inspector-placeholder-icon">📋</div>
                  <p>{t.selectEntry}</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
