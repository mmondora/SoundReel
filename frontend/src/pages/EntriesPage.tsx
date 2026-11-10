import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addEntryToCollection, fetchCollection, listEntrySummaries, removeEntryFromCollection } from '../services/api';
import { useLanguage } from '../i18n';
import { CollectionFacets, type FacetKey } from '../components/CollectionFacets';
import { CollectionRail } from '../components/CollectionRail';
import { EntriesView } from '../components/EntriesView';
import { ViewSwitch } from '../components/views/ViewSwitch';
import { useCollections } from '../hooks/useCollections';
import { usePageView } from '../hooks/useUiPrefs';
import type { CollectionChip, CollectionFacets as FacetsAnswer, CollectionListItem, EntrySummary } from '../types';

// The Link page: every post, newest first. Two views chosen by the user and kept on the server (look and feel P3): Studio (the list on the left,
// the post on the right: the default) and Bacheca (a wall of cards and a panel that closes). It lists summaries, so the post that is opened is
// read by its id.

const PAGE_SIZE = 40;

export function EntriesPage() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();
  const raccolta = searchParams.get('raccolta');
  const dove = searchParams.get('dove') ?? undefined;
  const fonte = searchParams.get('fonte') ?? undefined;
  const quando = searchParams.get('quando') ?? undefined;
  const { view, ready: viewReady } = usePageView('links');
  // the collections the server found: a failure is an empty list, and then there is no rail and the page is as it always was
  const { collections, reload: reloadCollections } = useCollections();
  // what can be put by hand: the themes (a type and a place are computed)
  const themes = useMemo(() => collections.filter((c) => c.kind === 'theme'), [collections]);

  const [items, setItems] = useState<EntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [facets, setFacets] = useState<FacetsAnswer | null>(null);
  /** The collection of the address does not exist (any more): a message and a way back, not a blank page. */
  const [gone, setGone] = useState(false);
  /** The server refused a correction on a chip (the row is as it was): which one, to say it. */
  const [chipError, setChipError] = useState<'remove' | 'add' | null>(null);
  /** Every load has a number; an answer that is not the last one asked for is dropped (a late answer of the collection chosen before). */
  const requestRef = useRef(0);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    const mine = ++requestRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      if (raccolta) {
        const page = await fetchCollection(raccolta, { dove, fonte, quando, offset, limit: PAGE_SIZE });
        if (mine !== requestRef.current) return;
        setGone(false);
        setFacets(page.facets);
        setTotal(page.total);
        setItems((prev) => (append ? [...prev, ...page.entries] : page.entries));
      } else {
        const page = await listEntrySummaries(PAGE_SIZE, offset);
        if (mine !== requestRef.current) return;
        setGone(false);
        setFacets(null);
        setTotal(page.total);
        setItems((prev) => (append ? [...prev, ...page.entries] : page.entries));
      }
    } catch (e) {
      if (mine !== requestRef.current) return;
      if (raccolta && e instanceof Error && /collection_not_found/.test(e.message)) {
        setGone(true);
        setFacets(null);
        setItems([]);
        setTotal(0);
      } else {
        console.error('[EntriesPage]', e);
        setError(t.error);
      }
    } finally {
      if (mine === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [raccolta, dove, fonte, quando, t.error]);

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

  // a post that was open in one collection is not open in the next
  useEffect(() => { setSelectedId(null); }, [raccolta]);

  /** A chip of the rail: it goes in the address, and the facets of the collection before are dropped (a place of one is not a place of another). */
  const chooseCollection = useCallback((id: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('raccolta', id);
      else next.delete('raccolta');
      next.delete('dove');
      next.delete('fonte');
      next.delete('quando');
      return next;
    });
  }, [setSearchParams]);

  const toggleFacet = useCallback((key: FacetKey, value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.get(key) === value) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }, [setSearchParams]);

  /** The open post was deleted: out of the list, one less in the count, nothing open. */
  const onDeleted = useCallback(() => {
    setItems((prev) => prev.filter((e) => e.id !== selectedId));
    setTotal((n) => Math.max(0, n - 1));
    setSelectedId(null);
  }, [selectedId]);

  /** «Non è questo» on a chip: the server forgets the post in that collection for good. The chip goes from the row; inside that very collection the post goes too. */
  const removeFromCollection = useCallback(async (entryId: string, chip: CollectionChip) => {
    try {
      await removeEntryFromCollection(chip.id, entryId);
    } catch (e) {
      console.error('[EntriesPage]', e);
      setChipError('remove');
      return;
    }
    setChipError(null);
    if (chip.id === raccolta) {
      setItems((prev) => prev.filter((e) => e.id !== entryId));
      setTotal((n) => Math.max(0, n - 1));
      setSelectedId((current) => (current === entryId ? null : current));
    } else {
      setItems((prev) => prev.map((e) => (e.id === entryId ? { ...e, collections: (e.collections ?? []).filter((c) => c.id !== chip.id) } : e)));
    }
    reloadCollections();   // the number of the collection changed
  }, [raccolta, reloadCollections]);

  /** «+»: the post enters the collection by hand and never leaves it. The chip appears on the row. */
  const addToCollection = useCallback(async (entryId: string, target: CollectionListItem) => {
    try {
      await addEntryToCollection(target.id, entryId);
    } catch (e) {
      console.error('[EntriesPage]', e);
      setChipError('add');
      return;
    }
    setChipError(null);
    setItems((prev) => prev.map((e) => (e.id === entryId ? { ...e, collections: [...(e.collections ?? []).filter((c) => c.id !== target.id), { id: target.id, name: target.name }] } : e)));
    reloadCollections();
  }, [reloadCollections]);

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

        <CollectionRail collections={collections} selectedId={raccolta} onSelect={chooseCollection} allCount={raccolta || loading ? null : total} />
        {raccolta && facets && <CollectionFacets facets={facets} current={{ dove, fonte, quando }} onToggle={toggleFacet} />}

        {chipError && <p className="collection-action-error" role="alert">{chipError === 'add' ? t.collectionChipAddFailed : t.collectionChipRemoveFailed}</p>}

        {waiting ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : gone ? (
          <div className="list-page-empty collection-gone">
            <p>{t.collectionGone}</p>
            <button type="button" className="library-load-btn" onClick={() => chooseCollection(null)}>{t.collectionGoneBack}</button>
          </div>
        ) : error ? (
          <div className="list-page-empty">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="list-page-empty">{t.noEntries}</div>
        ) : (
          <EntriesView
            entries={filtered}
            mode={view === 'wall' ? 'wall' : 'studio'}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeleted={onDeleted}
            onRemoveChip={(id, chip) => void removeFromCollection(id, chip)}
            addTargets={themes}
            onAddChip={(id, target) => void addToCollection(id, target)}
            footer={loadMore}
          />
        )}
      </div>
    </div>
  );
}
