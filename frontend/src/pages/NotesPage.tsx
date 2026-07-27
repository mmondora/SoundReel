import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { FilterPanel } from '../components/FilterPanel';
import type { FilterSection } from '../components/FilterPanel';
import { fetchNotes } from '../services/api';
import { filterNotes, collectCategories, sortNotes } from '../utils/noteFilters';
import type { NoteSortMode } from '../utils/noteFilters';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { AggregatedNote, NoteCategory, JournalStats } from '../types';
import type { Translations } from '../i18n/translations';

const CATEGORY_ICONS: Record<NoteCategory, string> = {
  place: '📍',
  event: '🎫',
  brand: '🏷',
  book: '📚',
  product: '📦',
  quote: '💬',
  person: '👤',
  other: '📝',
};

function categoryLabel(category: NoteCategory, t: Translations): string {
  const map: Record<NoteCategory, string> = {
    place: t.noteCategoryPlace,
    event: t.noteCategoryEvent,
    brand: t.noteCategoryBrand,
    book: t.noteCategoryBook,
    product: t.noteCategoryProduct,
    quote: t.noteCategoryQuote,
    person: t.noteCategoryPerson,
    other: t.noteCategoryOther,
  };
  return map[category] || category;
}

/** Client-side Google Maps search link for a place note — no geocoding, just a search query.
 * When lat/lon are provided, use them; otherwise fall back to text search. */
function mapsSearchUrl(query: string, lat?: number | null, lon?: number | null): string {
  if (lat != null && lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Joins author + year into a display byline, e.g. 'Frank Herbert (1965)'.
 * Either part may be missing — parts are joined via array + filter so a
 * missing author never leaves a stray leading space before '(1965)', and a
 * missing year never leaves a stray trailing space after the author. */
export function buildBookByline(author: string | null, year: number | null): string {
  const parts: string[] = [];
  if (author) parts.push(author);
  if (year) parts.push(`(${year})`);
  return parts.join(' ');
}

interface NoteRowProps {
  note: AggregatedNote;
}

function NoteRow({ note }: NoteRowProps) {
  const { t } = useLanguage();
  const [coverError, setCoverError] = useState(false);
  const meta = note.meta;
  const bookInfo = note.category === 'book' ? meta : null;
  const bookByline = bookInfo ? buildBookByline(bookInfo.bookAuthor, bookInfo.bookYear) : '';
  const placeInfo = note.category === 'place' ? meta : null;

  return (
    <div className="list-item-row">
      {bookInfo?.coverUrl && !coverError ? (
        <img
          src={bookInfo.coverUrl}
          alt=""
          className="note-cover"
          loading="lazy"
          onError={() => setCoverError(true)}
        />
      ) : (
        <div className="list-item-icon">{CATEGORY_ICONS[note.category] || '📝'}</div>
      )}
      <div className="list-item-content">
        <div className="list-item-title note-text">{note.text}</div>
        {bookByline && <div className="list-item-subtitle">{bookByline}</div>}
        {placeInfo?.placeDisplayName && (
          <div className="place-address" title={placeInfo.placeDisplayName}>
            {placeInfo.placeDisplayName}
          </div>
        )}
        <div className="list-item-badges">
          <span className="note-category-badge">
            {CATEGORY_ICONS[note.category] || '📝'} {categoryLabel(note.category, t)}
          </span>
          {note.category === 'place' && (
            <a
              href={mapsSearchUrl(note.text, placeInfo?.placeLat, placeInfo?.placeLon)}
              target="_blank"
              rel="noopener noreferrer"
              className="badge-link maps"
            >
              🗺 Maps
            </a>
          )}
          {placeInfo?.osmUrl && (
            <a href={placeInfo.osmUrl} target="_blank" rel="noopener noreferrer" className="badge-link osm">
              OSM
            </a>
          )}
          {bookInfo?.openlibraryUrl && (
            <a href={bookInfo.openlibraryUrl} target="_blank" rel="noopener noreferrer" className="badge-link openlibrary">
              OpenLibrary
            </a>
          )}
        </div>
      </div>
      <Link to={`/?entry=${note.mentions[0].entryId}`} className="list-item-action">
        ×{note.mentions.length} {t.notesMentions}
      </Link>
    </div>
  );
}

export function NotesPage() {
  const { entries } = useAllEntries();
  const { t } = useLanguage();

  const [notes, setNotes] = useState<AggregatedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [textFilter, setTextFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<NoteCategory[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sortMode, setSortMode] = useState<NoteSortMode>('date');

  useEffect(() => {
    fetchNotes().then(setNotes).catch(() => setNotes([])).finally(() => setLoading(false));
  }, []);

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const sortedNotes = useMemo(() => sortNotes(notes, sortMode), [notes, sortMode]);

  const categories = useMemo(() => collectCategories(sortedNotes), [sortedNotes]);
  const visible = useMemo(
    () => filterNotes(sortedNotes, { categories: categoryFilter, text: textFilter }),
    [sortedNotes, categoryFilter, textFilter]
  );

  function toggleCategory(category: NoteCategory) {
    setCategoryFilter((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  function resetFilters() {
    setCategoryFilter([]);
  }

  // Non-default filters count toward the "Filtri (n)" badge; text search is excluded on purpose.
  const activeFilterCount = categoryFilter.length;

  // FilterPanel's chips section is a plain string list, so localized labels
  // double as the chip identity here; toggleCategoryLabel maps a clicked
  // label back to its NoteCategory. Labels are unique per category so this
  // round-trip is unambiguous.
  const categoryChipOptions = useMemo(() => categories.map((c) => categoryLabel(c, t)), [categories, t]);
  const selectedCategoryLabels = useMemo(() => categoryFilter.map((c) => categoryLabel(c, t)), [categoryFilter, t]);

  function toggleCategoryLabel(label: string) {
    const found = categories.find((c) => categoryLabel(c, t) === label);
    if (found) toggleCategory(found);
  }

  const filterSections: FilterSection[] = [
    {
      kind: 'chips',
      label: t.categorySectionLabel,
      options: categoryChipOptions,
      selected: selectedCategoryLabels,
      onToggle: toggleCategoryLabel,
    },
  ];

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allNotes}</h1>
        </div>

        {!loading && (
          <>
            <div className="filter-topbar">
              <input
                type="text"
                className="filter-search"
                placeholder={`🔍 ${t.searchPlaceholder}`}
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
              />
              <span className="filter-result-count">{visible.length}</span>
              <select
                className="sort-select"
                value={sortMode}
                aria-label={t.sortLabel}
                onChange={(e) => setSortMode(e.target.value as NoteSortMode)}
              >
                <option value="date">{t.sortByDate}</option>
                <option value="mentions">{t.sortByMentions}</option>
              </select>
              <button type="button" className="filter-open-btn" onClick={() => setPanelOpen(true)}>
                {t.filtersButton}{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </button>
            </div>

            {activeFilterCount > 0 && (
              <div className="active-chips">
                {categoryFilter.map((category) => (
                  <button key={category} type="button" className="genre-chip active" onClick={() => toggleCategory(category)}>
                    {categoryLabel(category, t)} ×
                  </button>
                ))}
              </div>
            )}

            <FilterPanel
              open={panelOpen}
              onClose={() => setPanelOpen(false)}
              title={t.filtersTitle}
              onReset={resetFilters}
              resetLabel={t.filtersReset}
              sections={filterSections}
            />
          </>
        )}

        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="list-page-empty">{t.noNotesYet}</div>
        ) : (
          visible.map((note) => <NoteRow key={note.noteKey} note={note} />)
        )}
      </div>
    </div>
  );
}
