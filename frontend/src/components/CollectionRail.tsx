import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import type { CollectionListItem } from '../types';

// The rail of chips on top of «Link» (spec 2026-11-09-library-collections-auto-topics-design.md §6.1 A): «Tutte · Musica · Film e serie · ✦ Vino ·
// Ristoranti · …». The SERVER decided which collections exist, their names and their order (rule P): the rail draws at most 12 of them (the rest
// is on the page «Raccolte») and says which one is chosen; it computes nothing.

/** The most chips the rail shows. */
export const RAIL_LIMIT = 12;

export interface CollectionRailProps {
  collections: CollectionListItem[];
  /** The chosen collection (`?raccolta=`), or null for «All». */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** How many posts there are in all (the number of «All»), when known. */
  allCount: number | null;
}

export function CollectionRail({ collections, selectedId, onSelect, allCount }: CollectionRailProps) {
  const { t, language } = useLanguage();
  if (collections.length === 0) return null;

  const number = (n: number) => n.toLocaleString(language === 'it' ? 'it-IT' : 'en-US');
  const shown = collections.slice(0, RAIL_LIMIT);
  // a chosen collection beyond the twelfth still shows: the user must see what is filtering the list
  const chosen = selectedId ? collections.find((c) => c.id === selectedId) : undefined;
  const chips = chosen && !shown.includes(chosen) ? [...shown, chosen] : shown;

  return (
    <div className="collection-rail" role="group" aria-label={t.collectionsRailLabel}>
      <button type="button" className="collection-chip" aria-pressed={selectedId === null} onClick={() => onSelect(null)}>
        <span className="collection-chip-name">{t.collectionsAll}</span>
        {allCount !== null && <span className="collection-chip-count">{number(allCount)}</span>}
      </button>
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`collection-chip${c.isNew ? ' is-new' : ''}`}
          aria-pressed={c.id === selectedId}
          onClick={() => onSelect(c.id === selectedId ? null : c.id)}
        >
          <span className="collection-chip-name">{c.name}</span>
          {c.isNew && <span className="collection-new">{t.collectionNew}</span>}
          <span className="collection-chip-count">{number(c.count)}</span>
        </button>
      ))}
      {collections.length > RAIL_LIMIT && (
        <Link to="/collections" className="collection-chip collection-chip-more">{t.collectionsMore} ▾</Link>
      )}
    </div>
  );
}
