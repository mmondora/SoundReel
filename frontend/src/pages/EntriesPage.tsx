import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { listEntrySummaries } from '../services/api';
import { useLanguage } from '../i18n';
import type { EntrySummary } from '../types';

const PAGE_SIZE = 40;

function parseDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    instagram: 'IG', tiktok: 'TT', youtube: 'YT', facebook: 'FB',
    twitter: 'X', threads: 'TH', snapchat: 'SC', pinterest: 'PIN',
    linkedin: 'LI', reddit: 'RD', vimeo: 'VM', twitch: 'TW',
    spotify: 'SP', soundcloud: 'SND', shazam: 'SZ',
  };
  return labels[platform] || 'WEB';
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

export function EntriesPage() {
  const { t, language } = useLanguage();
  const [searchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const [items, setItems] = useState<EntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const hasMore = items.length < total && !q;
  const countLabel = t.entriesCountLabel
    .replace('{shown}', String(filtered.length))
    .replace('{total}', String(q ? filtered.length : total));

  return (
    <div className="list-page list-page--library">
      <Header />
      <div className="list-page-content">
        <div className="list-page-header library-header">
          <div className="library-header-text">
            <Link to="/" className="list-page-back">{t.back}</Link>
            <h1>{t.allEntries}</h1>
            {!loading && (
              <p className="library-count">{countLabel}</p>
            )}
          </div>
        </div>

        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : error ? (
          <div className="list-page-empty">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="list-page-empty">{t.noEntries}</div>
        ) : (
          <>
            <div className="library-list">
              {groups.map((group) => (
                <section key={group.key} className="library-day">
                  {group.label && (
                    <h2 className="library-day-label">{group.label}</h2>
                  )}
                  <ul className="library-rows">
                    {group.items.map((entry) => {
                      const date = parseDate(entry.createdAt);
                      const summary =
                        entry.summary ||
                        entry.caption?.substring(0, 140) ||
                        entry.sourceUrl;
                      return (
                        <li key={entry.id} className="library-row">
                          {entry.thumbnailUrl ? (
                            <img
                              src={entry.thumbnailUrl}
                              alt=""
                              className="library-thumb"
                              loading="lazy"
                            />
                          ) : (
                            <div className="library-thumb-placeholder">
                              {getPlatformLabel(entry.sourcePlatform)}
                            </div>
                          )}
                          <div className="library-row-body">
                            <div className="library-row-meta">
                              <span className="library-platform">
                                {getPlatformLabel(entry.sourcePlatform)}
                              </span>
                              {date && (
                                <span className="library-time">
                                  {date.toLocaleTimeString(
                                    language === 'it' ? 'it-IT' : 'en-US',
                                    { hour: '2-digit', minute: '2-digit' },
                                  )}
                                </span>
                              )}
                            </div>
                            <p className="library-summary">{summary}</p>
                            <div className="library-counts">
                              {entry.songCount > 0 && (
                                <span>🎵 {entry.songCount}</span>
                              )}
                              {entry.filmCount > 0 && (
                                <span>🎬 {entry.filmCount}</span>
                              )}
                              {entry.noteCount > 0 && (
                                <span>📝 {entry.noteCount}</span>
                              )}
                              {(entry.tags ?? []).slice(0, 4).map((tag) => (
                                <span key={tag} className="library-tag">{tag}</span>
                              ))}
                            </div>
                          </div>
                          <Link
                            to={`/?entry=${entry.id}`}
                            className="library-open"
                          >
                            {t.openEntry}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>

            {hasMore && (
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
            )}
          </>
        )}
      </div>
    </div>
  );
}
