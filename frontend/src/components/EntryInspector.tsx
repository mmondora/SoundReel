import { useEffect, useState, type ReactNode } from 'react';
import type { Entry, Note } from '../types';
import { SongItem } from './SongItem';
import { FilmItem } from './FilmItem';
import { ActivityTimeline } from './ActivityTimeline';
import {
  deleteEntry, retryEntry, enrichEntry, fetchEntryMedia,
  fetchEntryShares, shareEntryWith, unshareEntryWith, fetchMe,
} from '../services/api';
import type { EntryMediaUrls } from '../services/api';
import { useLanguage, interpolate } from '../i18n';
import { VERDICT_TONE, VERDICT_ICON } from '../utils/enrichmentVerdict';

interface EntryInspectorProps {
  entry: Entry;
  onBack?: () => void;
  /** Said after the post was deleted (a page that lists summaries takes it out of its list; the journal reloads by itself). */
  onDeleted?: () => void;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
    });
}

function renderCaptionWithLinks(text: string): ReactNode[] {
  const combined = /(https?:\/\/[^\s,)]+|@[\w.]+|#[\w\u00C0-\u024F]+)/g;
  const urlRegex = /(https?:\/\/[^\s,)]+)/g;
  const mentionRegex = /(@[\w.]+)/g;
  const hashtagRegex = /(#[\w\u00C0-\u024F]+)/g;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (urlRegex.test(token)) {
      parts.push(<a key={match.index} href={token} target="_blank" rel="noopener noreferrer" className="caption-link">{token}</a>);
    } else if (mentionRegex.test(token)) {
      parts.push(<span key={match.index} className="caption-mention">{token}</span>);
    } else if (hashtagRegex.test(token)) {
      parts.push(<span key={match.index} className="caption-hashtag">{token}</span>);
    } else {
      parts.push(token);
    }
    urlRegex.lastIndex = 0;
    mentionRegex.lastIndex = 0;
    hashtagRegex.lastIndex = 0;
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook',
    twitter: 'X', threads: 'Threads', snapchat: 'Snapchat', pinterest: 'Pinterest',
    linkedin: 'LinkedIn', reddit: 'Reddit', vimeo: 'Vimeo', twitch: 'Twitch',
    spotify: 'Spotify', soundcloud: 'SoundCloud', shazam: 'Shazam'
  };
  return labels[platform] || 'Web';
}

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

const NOTE_CATEGORY_LABELS: Record<Note['category'], { icon: string; key: keyof typeof import('../i18n/translations').translations.it }> = {
  place: { icon: '📍', key: 'notePlace' },
  event: { icon: '📅', key: 'noteEvent' },
  brand: { icon: '🏢', key: 'noteBrand' },
  book: { icon: '📖', key: 'noteBook' },
  product: { icon: '📦', key: 'noteProduct' },
  quote: { icon: '💬', key: 'noteQuote' },
  person: { icon: '👤', key: 'notePerson' },
  other: { icon: '📝', key: 'noteOther' }
};

export function EntryInspector({ entry, onBack, onDeleted }: EntryInspectorProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [localMedia, setLocalMedia] = useState<EntryMediaUrls | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [familyOpen, setFamilyOpen] = useState(false);
  const [familyTargets, setFamilyTargets] = useState<string[]>([]);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [familyBusy, setFamilyBusy] = useState(false);
  const [canManageShare, setCanManageShare] = useState(false);
  const { t, language } = useLanguage();

  useEffect(() => {
    let cancelled = false;
    setLocalMedia(null);
    setFrameIndex(0);
    void fetchEntryMedia(entry.id)
      .then((media) => {
        if (!cancelled) setLocalMedia(media);
      })
      .catch(() => {
        if (!cancelled) setLocalMedia(null);
      });
    return () => { cancelled = true; };
  }, [entry.id]);

  useEffect(() => {
    let cancelled = false;
    setFamilyOpen(false);
    setSharedWith([]);
    setFamilyTargets([]);
    setCanManageShare(false);
    void fetchMe()
      .then((me) => {
        if (cancelled) return;
        const owner = entry.ownerUser ?? 'mike';
        setCanManageShare(me.authenticated && me.user === owner);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [entry.id, entry.ownerUser]);

  const videoSrc = localMedia?.videoUrl || entry.mediaUrl;
  const isLocalVideo = !!localMedia?.videoUrl;
  const audioSrc = localMedia?.audioUrl;
  const frames = localMedia?.frames ?? [];
  const currentFrame = frames[frameIndex] ?? null;

  const dateLocale = language === 'it' ? 'it-IT' : 'en-US';
  const parsedDate = parseFirestoreDate(entry.createdAt);

  const hasSongs = entry.results.songs.length > 0;
  const hasFilms = entry.results.films.length > 0;
  const hasNotes = (entry.results.notes?.length || 0) > 0;
  const hasTags = (entry.results.tags?.length || 0) > 0;
  const hasEnrichments = !!entry.results.enrichments;
  const slides = entry.results.slides ?? [];
  // Top-level links + slide suggestions + enrichment deep links (older
  // carousels often leave results.links empty).
  const browsingLinks = (() => {
    const seen = new Set<string>();
    const out: Array<{ url: string; label: string }> = [];
    const add = (url: string, label: string | null | undefined) => {
      const trimmed = url?.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push({ url: trimmed, label: (label && label.trim()) || trimmed });
    };
    for (const link of entry.results.links ?? []) add(link.url, link.label || link.domain);
    for (const slide of slides) {
      for (const link of slide.links ?? []) add(link.url, link.label);
    }
    for (const item of entry.results.enrichments?.items ?? []) {
      for (const link of item.links ?? []) add(link.url, link.title || item.label);
    }
    return out;
  })();
  const hasLinks = browsingLinks.length > 0;
  const verdict = entry.results.enrichments?.verdict;
  const transcript = entry.results.transcript || entry.results.transcription || null;
  const hasTranscript = !!transcript;

  const handleDelete = async () => {
    if (!confirm(t.confirmDelete)) return;
    setDeleting(true);
    try { await deleteEntry(entry.id); onDeleted?.(); } catch { alert(t.deleteError); }
    finally { setDeleting(false); }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try { await retryEntry(entry.id, entry.sourceUrl); } catch { alert(t.retryError); }
    finally { setRetrying(false); }
  };

  const handleEnrich = async () => {
    setEnriching(true);
    try { await enrichEntry(entry.id); } catch { alert(t.enrichError); }
    finally { setEnriching(false); }
  };

  const handleCopyUrl = async () => {
    await navigator.clipboard.writeText(entry.sourceUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 2000);
  };

  const handleShareEntry = async () => {
    const shareUrl = `${window.location.origin}/?entry=${entry.id}`;
    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const openFamilyShare = async () => {
    setFamilyBusy(true);
    try {
      const data = await fetchEntryShares(entry.id);
      setFamilyTargets(data.family);
      setSharedWith(data.sharedWith);
      setFamilyOpen(true);
    } catch {
      alert(language === 'it' ? 'Condivisione non disponibile' : 'Sharing unavailable');
    } finally {
      setFamilyBusy(false);
    }
  };

  const toggleFamilyShare = async (userId: string) => {
    setFamilyBusy(true);
    try {
      if (sharedWith.includes(userId)) {
        const data = await unshareEntryWith(entry.id, userId);
        setSharedWith(data.sharedWith);
      } else {
        const data = await shareEntryWith(entry.id, [...sharedWith, userId]);
        setSharedWith(data.sharedWith);
      }
    } catch {
      alert(language === 'it' ? 'Errore condivisione' : 'Share error');
    } finally {
      setFamilyBusy(false);
    }
  };

  // Truncated transcript preview (3 lines ~ 200 chars)
  const transcriptPreview = transcript && transcript.length > 200
    ? transcript.substring(0, 200) + '...'
    : transcript;

  return (
    <div className="inspector">
      {/* Mobile back button */}
      {onBack && (
        <button className="inspector-back" onClick={onBack}>{t.back}</button>
      )}

      {/* Header */}
      <div className="inspector-header">
        {entry.thumbnailUrl && (
          <img src={entry.thumbnailUrl} alt="" className="inspector-thumb" loading="lazy" />
        )}
        <div className="inspector-header-info">
          {entry.caption && (
            <p className="inspector-caption">
              {decodeHtmlEntities(entry.caption).substring(0, 140)}
              {entry.caption.length > 140 ? '...' : ''}
            </p>
          )}
          <div className="inspector-meta">
            <span className="inspector-platform-badge">{getPlatformLabel(entry.sourcePlatform)}</span>
            {entry.ownerUser && (
              <span className="inspector-platform-badge" title="owner">
                {entry.ownerUser}
              </span>
            )}
            <span className={`inspector-status-badge ${entry.status}`}>
              {entry.status === 'processing' ? t.processing : entry.status === 'error' ? t.error : 'completed'}
            </span>
            {parsedDate && (
              <time className="inspector-date">
                {parsedDate.toLocaleDateString(dateLocale, {
                  day: 'numeric', month: 'long', year: 'numeric',
                  hour: '2-digit', minute: '2-digit'
                })}
              </time>
            )}
          </div>
          <div className="inspector-actions">
            {verdict && (
              <span
                className={`inspector-action-btn inspector-action-verdict enrichment-verdict-${VERDICT_TONE[verdict.label]}`}
                title={`${verdict.label.toUpperCase()} (${verdict.confidence}%) — ${verdict.explanation}`}
              >
                {VERDICT_ICON[verdict.label]}
              </span>
            )}
            <button className="inspector-action-btn" onClick={handleRetry} disabled={retrying} title={t.retryEntry}>
              {retrying ? '...' : '↻'}
            </button>
            <button className="inspector-action-btn" onClick={handleEnrich} disabled={enriching} title={t.enrichEntry}>
              {enriching ? '...' : '🔍'}
            </button>
            <button className="inspector-action-btn danger" onClick={handleDelete} disabled={deleting} title={t.deleteEntry}>
              {deleting ? '...' : '🗑'}
            </button>
            <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer" className="inspector-action-btn" title={t.openOriginal}>
              ↗
            </a>
            <button className="inspector-action-btn" onClick={handleCopyUrl} title={t.copyUrl}>
              {urlCopied ? '✓' : '📋'}
            </button>
            <button className="inspector-action-btn" onClick={handleShareEntry} title={t.shareEntry}>
              {shareCopied ? '✓' : '🔗'}
            </button>
            {canManageShare && (
              <button
                className="inspector-action-btn"
                onClick={() => { void openFamilyShare(); }}
                disabled={familyBusy}
                title={language === 'it' ? 'Condividi in famiglia' : 'Share with family'}
              >
                {familyBusy ? '...' : '👥'}
              </button>
            )}
          </div>
          {familyOpen && (
            <div className="inspector-family-share">
              <div className="inspector-family-share-title">
                {language === 'it' ? 'Condividi con' : 'Share with'}
              </div>
              {familyTargets.map((id) => (
                <label key={id} className="inspector-family-share-row">
                  <input
                    type="checkbox"
                    checked={sharedWith.includes(id)}
                    disabled={familyBusy}
                    onChange={() => { void toggleFamilyShare(id); }}
                  />
                  <span>{id}</span>
                </label>
              ))}
              {familyTargets.length === 0 && (
                <span className="inspector-family-share-empty">—</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Local / offline media replay */}
      {(videoSrc || audioSrc || frames.length > 0) && (
        <section className="inspector-section inspector-media-section">
          <h3 className="inspector-section-title">
            {t.localMediaSection}
            {isLocalVideo && <span className="local-media-badge">{t.localMediaBadge}</span>}
          </h3>
          {videoSrc && (
            <video
              key={videoSrc}
              className="inspector-video"
              src={videoSrc}
              controls
              preload="metadata"
              poster={localMedia?.thumbnailUrl || entry.thumbnailUrl || undefined}
            />
          )}
          {!videoSrc && audioSrc && (
            <audio key={audioSrc} className="inspector-audio" src={audioSrc} controls preload="metadata" />
          )}
          {frames.length > 0 && (
            <div className="inspector-frames">
              <div className="inspector-frames-toolbar">
                <button
                  type="button"
                  className="inspector-action-btn"
                  disabled={frameIndex <= 0}
                  onClick={() => setFrameIndex((i) => Math.max(0, i - 1))}
                  title={t.framePrev}
                >
                  ←
                </button>
                <span className="inspector-frames-count">
                  {frameIndex + 1} / {frames.length}
                </span>
                <button
                  type="button"
                  className="inspector-action-btn"
                  disabled={frameIndex >= frames.length - 1}
                  onClick={() => setFrameIndex((i) => Math.min(frames.length - 1, i + 1))}
                  title={t.frameNext}
                >
                  →
                </button>
              </div>
              {currentFrame && (
                <img src={currentFrame} alt="" className="inspector-frame-main" loading="lazy" />
              )}
              <div className="inspector-frame-strip">
                {frames.map((src, i) => (
                  <button
                    key={src}
                    type="button"
                    className={`inspector-frame-thumb ${i === frameIndex ? 'active' : ''}`}
                    onClick={() => setFrameIndex(i)}
                  >
                    <img src={src} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Summary */}
      {entry.results.summary && (
        <section className="inspector-section">
          <p className="inspector-summary">{entry.results.summary}</p>
        </section>
      )}

      {/* Transcript */}
      {hasTranscript && (
        <section className="inspector-section">
          <h3 className="inspector-section-title" onClick={() => setTranscriptExpanded(!transcriptExpanded)} style={{ cursor: 'pointer' }}>
            {t.transcript} {transcriptExpanded ? '▾' : '▸'}
          </h3>
          <p className="inspector-transcript">
            {transcriptExpanded ? transcript : transcriptPreview}
          </p>
          {transcript && transcript.length > 200 && (
            <button className="caption-toggle" onClick={() => setTranscriptExpanded(!transcriptExpanded)}>
              {transcriptExpanded ? t.showLess : t.showMore}
            </button>
          )}
        </section>
      )}

      {/* Caption full */}
      {entry.caption && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">Caption</h3>
          <div className="inspector-caption-full">
            {renderCaptionWithLinks(decodeHtmlEntities(entry.caption))}
          </div>
        </section>
      )}

      {/* Songs */}
      {hasSongs && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.songsSection}</h3>
          {entry.results.songs.map((song, i) => (
            <SongItem key={i} song={song} entryId={entry.id} songIndex={i} />
          ))}
        </section>
      )}

      {/* Films */}
      {hasFilms && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.filmsSection}</h3>
          {entry.results.films.map((film, i) => (
            <FilmItem key={i} film={film} />
          ))}
        </section>
      )}

      {/* Notes grouped by category */}
      {hasNotes && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.notesSection}</h3>
          {(() => {
            const grouped: Record<string, Note[]> = {};
            entry.results.notes.forEach(note => {
              const cat = note.category || 'other';
              if (!grouped[cat]) grouped[cat] = [];
              grouped[cat].push(note);
            });
            return Object.entries(grouped).map(([cat, notes]) => {
              const catInfo = NOTE_CATEGORY_LABELS[cat as Note['category']] || NOTE_CATEGORY_LABELS.other;
              return (
                <div key={cat} className="inspector-note-group">
                  <span className="inspector-note-category">{catInfo.icon} {t[catInfo.key]}</span>
                  <ul className="inspector-note-list">
                    {notes.map((note, i) => (
                      <li key={i} className="inspector-note-item">
                        {note.text}
                        {note.category === 'book' && (
                          <span className="note-book-links">
                            <a href={`https://www.amazon.it/s?k=${encodeURIComponent(note.text)}`} target="_blank" rel="noopener noreferrer" className="action-link amazon" title={t.buyOnAmazon}>AMZ</a>
                            <a href={`https://www.google.com/search?tbm=bks&q=${encodeURIComponent(note.text)}`} target="_blank" rel="noopener noreferrer" className="action-link gbooks" title={t.searchOnGoogleBooks}>GB</a>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            });
          })()}
        </section>
      )}

      {/* Links (AI + destinazioni suggerite dalle slide) */}
      {hasLinks && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.linksSection}</h3>
          <ul className="inspector-links">
            {browsingLinks.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="inspector-link">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Tags */}
      {(hasTags || verdict) && (
        <section className="inspector-section">
          <div className="inspector-tags">
            {verdict && (
              <span className={`tag-badge inspector-tag-verdict enrichment-verdict-${VERDICT_TONE[verdict.label]}`}>
                {VERDICT_ICON[verdict.label]} {verdict.label.toUpperCase()}
              </span>
            )}
            {entry.results.tags.map((tag, i) => (
              <span key={i} className="tag-badge">{tag}</span>
            ))}
          </div>
        </section>
      )}

      {/* Per-slide breakdown (carousels) */}
      {slides.length > 0 && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.slidesSection}</h3>
          {slides.map((slide) => (
            <div key={slide.index} className="slide-block">
              {slide.imageUrl && (
                <img
                  src={slide.imageUrl}
                  alt=""
                  className="slide-thumb"
                  loading="lazy"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
              )}
              <div className="slide-body">
                <span className="slide-counter">
                  {interpolate(t.slideCounter, { n: slide.index + 1, total: slides.length })}
                </span>
                {slide.summary && <p className="slide-summary">{slide.summary}</p>}
                {!slide.summary && slide.visualDescription && (
                  <p className="slide-summary slide-visual">{slide.visualDescription}</p>
                )}
                {slide.links.length > 0 && (
                  <div className="slide-links">
                    <span className="slide-links-label">{t.slideSuggestedLinks}</span>
                    {slide.links.map((link) => (
                      <a
                        key={link.url}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="slide-link"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                )}
                {slide.ocrText && (
                  <details className="slide-ocr">
                    <summary>{t.slideOcrText}</summary>
                    <p>{slide.ocrText}</p>
                  </details>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Enrichments */}
      {hasEnrichments && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.enrichmentsSection}</h3>
          {entry.results.enrichments!.verdict && (
            <div className={`enrichment-verdict enrichment-verdict-${VERDICT_TONE[entry.results.enrichments!.verdict.label]}`}>
              <span className="enrichment-verdict-label">{entry.results.enrichments!.verdict.label.toUpperCase()}</span>
              <span className="enrichment-verdict-confidence">{entry.results.enrichments!.verdict.confidence}%</span>
              <p className="enrichment-verdict-explanation">{entry.results.enrichments!.verdict.explanation}</p>
            </div>
          )}
          {entry.results.enrichments!.items.map((item, i) => (
            <div key={i} className="enrichment-item">
              <span className="enrichment-label">{item.label}</span>
              {item.explanation && <p className="enrichment-item-explanation">{item.explanation}</p>}
              <ul className="enrichment-links">
                {item.links.map((link, li) => (
                  <li key={li} className="enrichment-link">
                    <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a>
                    {link.snippet && <span className="enrichment-snippet">{link.snippet}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {/* Deep Search prompt if no enrichments */}
      {!hasEnrichments && entry.status === 'completed' && (
        <section className="inspector-section">
          <button className="inspector-deepsearch-btn" onClick={handleEnrich} disabled={enriching}>
            {enriching ? t.enriching : t.runDeepSearch}
          </button>
        </section>
      )}

      {/* Activity Timeline */}
      {entry.actionLog.length > 0 && (
        <section className="inspector-section inspector-activity">
          <ActivityTimeline
            actionLog={entry.actionLog}
            isProcessing={entry.status === 'processing'}
          />
        </section>
      )}
    </div>
  );
}
