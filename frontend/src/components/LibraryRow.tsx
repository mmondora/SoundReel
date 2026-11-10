import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import { platformLabel } from '../utils/platformLabel';
import { VERDICT_ICON, VERDICT_TONE } from '../utils/enrichmentVerdict';
import { CollectionChips } from './CollectionChips';
import type { CollectionChip, CollectionListItem, EnrichmentVerdictLabel, EntrySummary } from '../types';

function parseDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

export interface RowProps {
  entry: EntrySummary;
  selected: boolean;
  onSelect: (id: string) => void;
  /** The «×» of a theme chip («non è questo»). Without it the chips have no «×». */
  onRemoveChip?: (entryId: string, chip: CollectionChip) => void;
  /** The collections the «+» of the chips offers (the themes of the user), and what to do when one is chosen. */
  addTargets?: CollectionListItem[];
  onAddChip?: (entryId: string, collection: CollectionListItem) => void;
}

/** One post of the list. The whole row opens the post (a button laid over it, named by the summary); «Apri» still goes to the Inbox. */
export function LibraryRow({ entry, selected, onSelect, onRemoveChip, addTargets, onAddChip }: RowProps) {
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
          {entry.status === 'processing' && <span className="library-spinner" role="status" aria-label={t.statusProcessing} />}
          {entry.status === 'error' && <span className="library-failed" role="img" aria-label={t.error} title={t.error}>⚠</span>}
          {entry.verdict && (
            <span
              className={`library-verdict enrichment-verdict-${VERDICT_TONE[entry.verdict.label as EnrichmentVerdictLabel] ?? 'warning'}`}
              title={`${entry.verdict.label.toUpperCase()} (${entry.verdict.confidence}%)`}
            >
              {VERDICT_ICON[entry.verdict.label as EnrichmentVerdictLabel] ?? '•'}
            </span>
          )}
        </div>
        <p className="library-summary" id={summaryId}>{summary}</p>
        <div className="library-counts">
          {entry.songCount > 0 && <span>🎵 {entry.songCount}</span>}
          {entry.filmCount > 0 && <span>🎬 {entry.filmCount}</span>}
          {entry.noteCount > 0 && <span>📝 {entry.noteCount}</span>}
          <CollectionChips
            chips={entry.collections}
            tags={entry.tags}
            onRemove={onRemoveChip ? (chip) => onRemoveChip(entry.id, chip) : undefined}
            addTargets={addTargets}
            onAdd={onAddChip ? (collection) => onAddChip(entry.id, collection) : undefined}
          />
        </div>
      </div>
      <Link to={`/?entry=${entry.id}`} className="library-open">
        {t.openEntry}
      </Link>
    </li>
  );
}
