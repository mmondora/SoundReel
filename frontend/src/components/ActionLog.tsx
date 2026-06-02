import { useState } from 'react';
import type { ActionLogItem } from '../types';
import { useLanguage } from '../i18n';

interface ActionLogProps {
  log: ActionLogItem[];
}

function statusColor(details: Record<string, unknown>): string {
  const s = details.status as string | undefined;
  const f = details.found as boolean | undefined;
  if (s === 'error') return 'log-status-error';
  if (s === 'skipped') return 'log-status-skipped';
  if (f === false) return 'log-status-warn';
  if (s === 'ok' || f === true) return 'log-status-ok';
  return '';
}

function truncateUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  return url.slice(0, max) + '…';
}

function renderValue(_key: string, val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? '✓' : '✗';
  if (typeof val === 'string') {
    if (val.startsWith('http')) return truncateUrl(val);
    return val;
  }
  if (typeof val === 'number') return String(val);
  return JSON.stringify(val);
}

function DetailRow({ k, v }: { k: string; v: unknown }) {
  const isUrl = typeof v === 'string' && v.startsWith('http');
  const display = renderValue(k, v);
  const isBool = typeof v === 'boolean';
  const colorClass = isBool ? (v ? 'detail-true' : 'detail-false') : '';

  return (
    <div className="log-detail-row">
      <span className="log-detail-key">{k}</span>
      {isUrl ? (
        <a href={v as string} target="_blank" rel="noopener noreferrer" className="log-detail-url">
          {display}
        </a>
      ) : (
        <span className={`log-detail-val ${colorClass}`}>{String(display)}</span>
      )}
    </div>
  );
}

function TrackList({ tracks }: { tracks: Array<Record<string, unknown>> }) {
  return (
    <div className="log-tracks">
      {tracks.map((t, i) => (
        <div key={i} className="log-track-item">
          <span className="log-track-title">{String(t.title ?? '?')}</span>
          <span className="log-track-artist">{String(t.artist ?? '')}</span>
          {typeof t.spotifyUrl === 'string' && t.spotifyUrl && (
            <a href={t.spotifyUrl} target="_blank" rel="noopener noreferrer" className="log-track-link">spotify</a>
          )}
          {t.timestampMs != null && (
            <span className="log-track-ts">{Math.round(Number(t.timestampMs) / 1000)}s</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Details({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details);
  if (entries.length === 0) return null;
  return (
    <div className="log-details">
      {entries.map(([k, v]) => {
        if (Array.isArray(v) && k === 'tracks') {
          return (
            <div key={k} className="log-detail-row log-detail-tracks">
              <span className="log-detail-key">{k}</span>
              <TrackList tracks={v as Array<Record<string, unknown>>} />
            </div>
          );
        }
        if (Array.isArray(v)) {
          return <DetailRow key={k} k={k} v={`[${v.length} items]`} />;
        }
        return <DetailRow key={k} k={k} v={v} />;
      })}
    </div>
  );
}

function ActionItem({ item }: { item: ActionLogItem }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Object.keys(item.details ?? {}).length > 0;
  const colorClass = statusColor(item.details ?? {});

  return (
    <li className={`action-log-item ${colorClass}`}>
      <div className="action-log-item-header" onClick={() => hasDetails && setOpen(!open)}>
        <span className="action-name">{item.action}</span>
        <div className="action-log-item-right">
          {hasDetails && (
            <span className="action-expand">{open ? '▾' : '▸'}</span>
          )}
          <span className="action-time">
            {new Date(item.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>
      {open && hasDetails && <Details details={item.details} />}
    </li>
  );
}

export function ActionLog({ log }: ActionLogProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useLanguage();

  if (log.length === 0) return null;

  return (
    <div className="action-log">
      <button
        className="action-log-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? t.hideLog : t.showLog} ({log.length} step)
      </button>
      {expanded && (
        <ul className="action-log-list">
          {log.map((item, index) => (
            <ActionItem key={index} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
