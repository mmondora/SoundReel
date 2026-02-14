import { useState } from 'react';
import type { ActionLogItem } from '../types';
import { useLanguage } from '../i18n';

interface ActivityTimelineProps {
  actionLog: ActionLogItem[];
  isProcessing: boolean;
}

const ACTION_LABELS: Record<string, { it: string; en: string }> = {
  url_received: { it: 'URL ricevuto', en: 'URL received' },
  content_extracted: { it: 'Estrazione contenuto', en: 'Content extraction' },
  media_downloaded: { it: 'Download media', en: 'Media download' },
  media_download_skipped: { it: 'Download media', en: 'Media download' },
  media_download_failed: { it: 'Download media', en: 'Media download' },
  transcribe: { it: 'Trascrizione audio', en: 'Audio transcription' },
  audio_analyzed: { it: 'Audio fingerprint', en: 'Audio fingerprint' },
  ai_analyzed: { it: 'Analisi AI (Gemini)', en: 'AI Analysis (Gemini)' },
  media_analysis_complete: { it: 'Analisi media', en: 'Media analysis' },
  spotify_added: { it: 'Spotify lookup', en: 'Spotify lookup' },
  film_found: { it: 'TMDb lookup', en: 'TMDb lookup' },
  auto_enriched: { it: 'Auto-enrichment', en: 'Auto-enrichment' },
  auto_enrich_failed: { it: 'Auto-enrichment', en: 'Auto-enrichment' },
  completed: { it: 'Completato', en: 'Completed' },
};

function getActionLabel(action: string, lang: string): string {
  const labels = ACTION_LABELS[action];
  if (labels) return lang === 'it' ? labels.it : labels.en;
  return action.replace(/_/g, ' ');
}

function getActionStatus(action: string, details: Record<string, unknown>): 'success' | 'error' | 'skipped' {
  if (action.includes('failed') || action.includes('error')) return 'error';
  if (action.includes('skipped')) return 'skipped';
  if (details.status === 'error') return 'error';
  if (details.status === 'skipped') return 'skipped';
  if (details.found === false && action === 'audio_analyzed') return 'skipped';
  return 'success';
}

function getStatusIcon(status: 'success' | 'error' | 'skipped' | 'processing'): string {
  switch (status) {
    case 'success': return '✓';
    case 'error': return '✗';
    case 'skipped': return '⏭';
    case 'processing': return '⟳';
  }
}

function getSubtitle(action: string, details: Record<string, unknown>, lang: string): string {
  switch (action) {
    case 'url_received':
      return `${details.platform || 'web'} (${details.channel || 'web'})`;
    case 'content_extracted':
      return [
        details.hasCaption ? 'caption' : null,
        details.hasThumbnail ? 'thumbnail' : null,
        details.hasAudio ? 'audio' : null,
      ].filter(Boolean).join(', ') || (lang === 'it' ? 'nessun dato' : 'no data');
    case 'transcribe': {
      const status = details.status as string;
      if (status === 'skipped') return details.reason as string || 'skipped';
      if (status === 'error') return details.reason as string || details.error as string || 'error';
      const len = details.transcriptLength as number;
      return len ? `${len} ${lang === 'it' ? 'caratteri' : 'chars'}` : (lang === 'it' ? 'nessun parlato' : 'no speech');
    }
    case 'audio_analyzed': {
      if (details.found === false) return lang === 'it' ? 'nessuna corrispondenza' : 'no match';
      return `${details.title || ''} — ${details.artist || ''} (${details.provider || 'audd'})`;
    }
    case 'ai_analyzed':
      return `${details.songs || 0} songs, ${details.films || 0} films, ${details.notes || 0} notes`;
    case 'media_downloaded':
      return details.mimeType as string || '';
    case 'media_download_skipped':
      return details.reason as string || 'skipped';
    case 'media_download_failed':
      return details.error as string || 'failed';
    case 'spotify_added':
      return `${details.track || ''} — ${details.artist || ''}`;
    case 'film_found':
      return `${details.title || ''} (${details.found ? '✓' : '✗'})`;
    case 'auto_enriched':
      return `${details.items || 0} items, ${details.links || 0} links`;
    case 'auto_enrich_failed':
      return details.error as string || 'failed';
    case 'completed': {
      const s = details.totalSongs as number || 0;
      const f = details.totalFilms as number || 0;
      const playlist = details.addedToPlaylist as number || 0;
      return `${s} songs, ${f} films, ${playlist} playlist`;
    }
    default:
      return '';
  }
}

function maskSensitiveData(value: string): string {
  // Mask tokens, cookies, API keys (keep first 4 and last 4 chars)
  return value.replace(/([a-zA-Z0-9_-]{12,})/g, (match) => {
    if (match.length <= 8) return match;
    return match.substring(0, 4) + '***' + match.substring(match.length - 4);
  });
}

function computeCost(details: Record<string, unknown>): string | null {
  const tokenUsage = details.tokenUsage as Record<string, unknown> | undefined;
  if (!tokenUsage) return null;
  const cost = tokenUsage.estimatedCostUSD as number | undefined;
  if (cost === undefined || cost === 0) return null;
  return `$${cost.toFixed(4)}`;
}

function computeDuration(log: ActionLogItem[], index: number): string | null {
  const item = log[index];
  const details = item.details;

  // Use durationMs if available
  if (typeof details.durationMs === 'number') {
    return (details.durationMs / 1000).toFixed(1) + 's';
  }

  // Calculate from timestamps
  if (index < log.length - 1) {
    const current = new Date(item.timestamp).getTime();
    const next = new Date(log[index + 1].timestamp).getTime();
    if (!isNaN(current) && !isNaN(next)) {
      const diff = (next - current) / 1000;
      if (diff >= 0) return diff.toFixed(1) + 's';
    }
  }

  return null;
}

export function ActivityTimeline({ actionLog, isProcessing }: ActivityTimelineProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const { language } = useLanguage();

  if (actionLog.length === 0) return null;

  return (
    <div className="activity-timeline">
      <h3 className="inspector-section-title">Activity</h3>
      <div className="timeline">
        {actionLog.map((item, index) => {
          const isLast = index === actionLog.length - 1;
          const status = isLast && isProcessing ? 'processing' : getActionStatus(item.action, item.details);
          const icon = getStatusIcon(status);
          const label = getActionLabel(item.action, language);
          const subtitle = getSubtitle(item.action, item.details, language);
          const duration = computeDuration(actionLog, index);
          const cost = computeCost(item.details);
          const isExpanded = expandedIndex === index;

          return (
            <div
              key={index}
              className={`timeline-step ${status}`}
              onClick={() => setExpandedIndex(isExpanded ? null : index)}
            >
              <div className="timeline-connector">
                <span className={`timeline-icon ${status}`}>{icon}</span>
                {index < actionLog.length - 1 && <div className="timeline-line" />}
              </div>
              <div className="timeline-content">
                <div className="timeline-header">
                  <span className="timeline-label">{label}</span>
                  <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {cost && <span className="timeline-cost">{cost}</span>}
                    {duration && <span className="timeline-duration">{duration}</span>}
                  </span>
                </div>
                {subtitle && <p className="timeline-subtitle">{subtitle}</p>}
                {isExpanded && (
                  <div className="timeline-details">
                    <pre className="timeline-json">
                      {maskSensitiveData(JSON.stringify(item.details, null, 2))}
                    </pre>
                    <button
                      className="timeline-copy-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(JSON.stringify(item.details, null, 2));
                      }}
                    >
                      Copy JSON
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
