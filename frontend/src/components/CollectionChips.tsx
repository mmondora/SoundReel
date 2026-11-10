import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { interpolate, useLanguage } from '../i18n';
import type { CollectionChip, CollectionListItem } from '../types';

// The chips of a card (spec 2026-11-09-library-collections-auto-topics-design.md §6.5): the collections the post is in first (at most 2 of theme and
// the place: the SERVER chose them), then the real tags, at most four chips in all. The placeholder tags the model copied from its prompt (`#tag`,
// `@utente`, `#hashtag`: 129 and 75 entries in the library) are not shown any more (the stored data keeps them). A «×» on a theme chip is «non è
// questo»: the post leaves that collection and does not come back. A «+» is «add to…»: the post enters a collection by hand and does not leave it.

/** The most chips a card shows, collections and tags together. */
export const MAX_CHIPS = 4;

const PLACEHOLDERS = new Set(['tag', 'utente', 'hashtag']);

/** `#tag`, `@utente`, `#hashtag` (with or without the sign, any case): words from the prompt, not tags of the post. */
export function isPlaceholderTag(tag: string): boolean {
  return PLACEHOLDERS.has(tag.trim().replace(/^[#@]/, '').toLowerCase());
}

/** The real tags, in their order, without the placeholders and the empty ones, at most `limit`. */
export function visibleTags(tags: readonly string[] | undefined, limit: number): string[] {
  return (tags ?? []).filter((tag) => tag.trim() !== '' && !isPlaceholderTag(tag)).slice(0, Math.max(0, limit));
}

/** The place and the types are computed by the server: only a theme can be corrected. */
const isTheme = (chip: CollectionChip): boolean => !chip.id.startsWith('place:') && !chip.id.startsWith('type:');

export interface CollectionChipsProps {
  /** What the server sent for the post; an older server sends nothing. */
  chips?: CollectionChip[];
  tags?: string[];
  /** The «×» of a theme chip. Without it there is no «×». */
  onRemove?: (chip: CollectionChip) => void;
  /** False inside a card that is a button itself (the wall): chips are plain text there, no links, no buttons. */
  interactive?: boolean;
  /** The collections a post can be put in by hand (the themes the user has). With `onAdd` they make the «+» menu. */
  addTargets?: CollectionListItem[];
  onAdd?: (collection: CollectionListItem) => void;
}

export function CollectionChips({ chips = [], tags = [], onRemove, interactive = true, addTargets = [], onAdd }: CollectionChipsProps) {
  const { t } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const shownChips = chips.slice(0, MAX_CHIPS);
  const shownTags = visibleTags(tags, MAX_CHIPS - shownChips.length);
  const offered = interactive && onAdd ? addTargets.filter((target) => !chips.some((chip) => chip.id === target.id)) : [];

  // a click anywhere else closes the menu (Escape closes it too: see the handler on the menu)
  useEffect(() => {
    if (!menuOpen) return undefined;
    const away = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menuOpen]);

  if (shownChips.length + shownTags.length === 0 && offered.length === 0) return null;
  return (
    <span className={`collection-chips${menuOpen ? ' has-menu-open' : ''}`} role="group" aria-label={t.collectionChipsLabel} ref={wrapRef}>
      {shownChips.map((chip) =>
        interactive ? (
          <span key={chip.id} className="collection-post-chip-wrap">
            <Link className="collection-post-chip" to={`/entries?raccolta=${encodeURIComponent(chip.id)}`}>{chip.name}</Link>
            {onRemove && isTheme(chip) && (
              <button type="button" className="collection-chip-x" aria-label={interpolate(t.collectionChipRemove, { name: chip.name })} onClick={() => onRemove(chip)}>×</button>
            )}
          </span>
        ) : (
          <span key={chip.id} className="collection-post-chip">{chip.name}</span>
        ),
      )}
      {shownTags.map((tag) => <span key={tag} className="collection-tag-chip">{tag}</span>)}
      {offered.length > 0 && (
        <span
          className="collection-add"
          onKeyDown={(event) => { if (event.key === 'Escape' && menuOpen) { event.stopPropagation(); setMenuOpen(false); } }}
        >
          <button type="button" className="collection-add-btn" aria-label={t.collectionChipAdd} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>+</button>
          {menuOpen && (
            <span className="collection-add-menu" role="menu">
              {offered.map((target) => (
                <button key={target.id} type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAdd?.(target); }}>{target.name}</button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
