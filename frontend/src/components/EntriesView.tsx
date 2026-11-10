import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLanguage } from '../i18n';
import { useEntryById } from '../hooks/useEntryById';
import { EntryInspector } from './EntryInspector';
import { LibraryRow } from './LibraryRow';
import { DetailPanel } from './views/DetailPanel';
import { Wall } from './views/Wall';
import { postFromSummary } from './views/postCard';
import type { CollectionChip, CollectionListItem, EntrySummary } from '../types';

// The posts of a page that lists summaries, in the two views the user can choose (look and feel P3): Studio (the list by day on the left, the post
// on the right) and Bacheca (a wall of cards and a panel that closes). The Link page and the page of a collection both draw their posts here. The page
// that uses it keeps what is open (`selectedId`) and the data; this reads the open post by its id and draws.

export type EntriesMode = 'wall' | 'studio';

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

export interface EntriesViewProps {
  entries: EntrySummary[];
  mode: EntriesMode;
  /** The post that is open, or none. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Said after the open post was deleted: the page takes it out of its list. */
  onDeleted: () => void;
  /** The «×» of a theme chip on a row. Without it the chips have no «×». */
  onRemoveChip?: (entryId: string, chip: CollectionChip) => void;
  /** The «+» of the chips: the collections it offers, and what to do when one is chosen. */
  addTargets?: CollectionListItem[];
  onAddChip?: (entryId: string, collection: CollectionListItem) => void;
  /** A page of a longer list (the Inbox): when this changes the list goes back to the top. */
  scrollKey?: unknown;
  /** When this goes up the open post is read again (the library changed: an analysis moved). */
  version?: number;
  /** What opens the list (the venues of a collection). */
  header?: ReactNode;
  /** What closes the list («load more»). */
  footer?: ReactNode;
}

export function EntriesView({ entries, mode, selectedId, onSelect, onDeleted, onRemoveChip, addTargets, onAddChip, scrollKey, version = 0, header, footer }: EntriesViewProps) {
  const { t, language } = useLanguage();
  const { entry: selectedEntry, loading: selectedLoading } = useEntryById(selectedId, undefined, version);
  const wallScroll = useRef<HTMLDivElement>(null);
  const listScroll = useRef<HTMLDivElement>(null);

  // a new page of a longer list starts at its first post
  useEffect(() => {
    if (scrollKey === undefined) return;
    if (wallScroll.current) wallScroll.current.scrollTop = 0;
    if (listScroll.current) listScroll.current.scrollTop = 0;
  }, [scrollKey]);
  const closeDetail = useCallback(() => onSelect(null), [onSelect]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: EntrySummary[] }[] = [];
    let lastKey = '';
    for (const entry of entries) {
      const date = parseDate(entry.createdAt);
      const key = date ? date.toDateString() : 'unknown';
      if (key !== lastKey) {
        out.push({ key, label: date ? formatDayLabel(date, language, t.today, t.yesterday) : '', items: [] });
        lastKey = key;
      }
      out[out.length - 1].items.push(entry);
    }
    return out;
  }, [entries, language, t.today, t.yesterday]);

  const posts = useMemo(() => entries.map(postFromSummary), [entries]);

  if (mode === 'wall') {
    return (
      <div className="wall-layout links-wall">
        <div className="wall-scroll" ref={wallScroll}>
          {header}
          <Wall posts={posts} selectedId={selectedId} onSelect={onSelect} />
          {footer}
        </div>
        {selectedEntry && (
          <DetailPanel onClose={closeDetail}>
            <EntryInspector entry={selectedEntry} onDeleted={onDeleted} />
          </DetailPanel>
        )}
      </div>
    );
  }

  return (
    <div className={`links-split${selectedId ? ' has-selection' : ''}`}>
      <div className="links-list" ref={listScroll}>
        {header}
        <div className="library-list">
          {groups.map((group) => (
            <section key={group.key} className="library-day">
              {group.label && (
                <h2 className="library-day-label">{group.label}</h2>
              )}
              <ul className="library-rows">
                {group.items.map((entry) => (
                  <LibraryRow key={entry.id} entry={entry} selected={entry.id === selectedId} onSelect={onSelect} onRemoveChip={onRemoveChip} addTargets={addTargets} onAddChip={onAddChip} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        {footer}
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
  );
}
