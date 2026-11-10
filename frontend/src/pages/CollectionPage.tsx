import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  addEntryToCollection, fetchCollection, fetchSongs, hideCollection, mergeCollection, removeEntryFromCollection, renameCollection,
} from '../services/api';
import { interpolate, useLanguage } from '../i18n';
import { usePlayer } from '../player/PlayerContext';
import { CollectionFacets, type FacetKey } from '../components/CollectionFacets';
import { EntriesView } from '../components/EntriesView';
import { SegmentedControl } from '../components/SegmentedControl';
import { VenueList } from '../components/VenueList';
import { useCollections } from '../hooks/useCollections';
import { useEntryById } from '../hooks/useEntryById';
import type {
  AggregatedSong, CollectionChip, CollectionEntry, CollectionListItem, CollectionPage as CollectionAnswer, CollectionView,
} from '../types';

// The page of one collection (spec 2026-11-09-library-collections-auto-topics-design.md §6.4, contract docs/collections.md). The SERVER decides everything
// here: which views make sense for this collection (`views`, `defaultView`), the facets, the posts, the venues with the address of Maps, the words that say
// why the posts are together. The page draws those and nothing else; only a theme can be corrected (rename, merge, hide, «not this one»).

const PAGE_SIZE = 40;

/** One of the two most typical posts of the collection («Why is it here?»): read by its id, left out if it cannot be read. */
function TypicalPost({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { entry } = useEntryById(id);
  if (!entry) return null;
  const text = entry.results?.summary?.trim() || entry.caption?.trim() || entry.sourceUrl;
  return <button type="button" className="collection-typical" onClick={() => onOpen(id)}>{text}</button>;
}

interface BodyProps {
  id: string;
}

function CollectionBody({ id }: BodyProps) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { playSong } = usePlayer();
  const { collections: mine, loading: minesLoading, reload: reloadMine } = useCollections();
  const dove = searchParams.get('dove') ?? undefined;
  const fonte = searchParams.get('fonte') ?? undefined;
  const quando = searchParams.get('quando') ?? undefined;

  const [answer, setAnswer] = useState<CollectionAnswer | null>(null);
  const [collection, setCollection] = useState<CollectionListItem | null>(null);
  const [items, setItems] = useState<CollectionEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [gone, setGone] = useState(false);
  const [chosenView, setChosenView] = useState<CollectionView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<'rename' | 'merge' | null>(null);
  const [draft, setDraft] = useState('');
  const [playing, setPlaying] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  /** Every load has a number; an answer that is not the last one asked for is dropped (a slow answer for filters the user already changed). */
  const requestRef = useRef(0);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    const mine = ++requestRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setFailed(false);
    try {
      const page = await fetchCollection(id, { dove, fonte, quando, offset, limit: PAGE_SIZE });
      if (mine !== requestRef.current) return;
      setGone(false);
      setAnswer(page);
      setCollection(page.collection);
      setTotal(page.total);
      setItems((prev) => (append ? [...prev, ...page.entries] : page.entries));
    } catch (e) {
      if (mine !== requestRef.current) return;
      if (e instanceof Error && /collection_not_found/.test(e.message)) {
        setGone(true);
      } else {
        console.error('[CollectionPage]', e);
        setFailed(true);
      }
    } finally {
      if (mine === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [id, dove, fonte, quando]);

  useEffect(() => {
    void loadPage(0, false);
  }, [loadPage]);

  const toggleFacet = useCallback((key: FacetKey, value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.get(key) === value) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }, [setSearchParams]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  /** An action of the page that the server refused or could not do: the page says so, and stays as it was. */
  const attempt = useCallback(async (action: () => Promise<void>) => {
    setActionFailed(false);
    try {
      await action();
    } catch (e) {
      console.error('[CollectionPage]', e);
      setActionFailed(true);
    }
  }, []);

  const startRename = (): void => {
    setDraft(collection?.name ?? '');
    setPanel('rename');
    closeMenu();
  };

  const startMerge = (): void => {
    setPanel('merge');
    closeMenu();
  };

  const submitRename = (event: FormEvent): void => {
    event.preventDefault();
    const name = draft.trim();
    void attempt(async () => {
      setCollection(await renameCollection(id, name));
      setPanel(null);
    });
  };

  const mergeInto = (targetId: string): void => {
    void attempt(async () => {
      const target = await mergeCollection(id, targetId);
      navigate(`/collections/${encodeURIComponent(target.id)}`);
    });
  };

  const hide = (): void => {
    closeMenu();
    void attempt(async () => {
      await hideCollection(id);
      navigate('/collections');
    });
  };

  const playAll = (): void => {
    const keys = answer?.songKeys ?? [];
    setPlaying(true);
    void attempt(async () => {
      const songs = await fetchSongs('journal');
      const byKey = new Map(songs.map((song) => [song.songKey, song]));
      const queue = keys.map((key) => byKey.get(key)).filter((song): song is AggregatedSong => song !== undefined);
      if (queue.length === 0) throw new Error('no song of the collection could be found');
      playSong(queue[0].songKey, queue, collection?.name ?? null);
    }).finally(() => setPlaying(false));
  };

  /** «Not this one» on a chip: the server forgets the post in that collection for good. Inside that very collection the post goes from the list too. */
  const removeFromCollection = useCallback(async (entryId: string, chip: CollectionChip) => {
    await attempt(async () => {
      await removeEntryFromCollection(chip.id, entryId);
      if (chip.id === id) {
        setItems((prev) => prev.filter((e) => e.id !== entryId));
        setTotal((n) => Math.max(0, n - 1));
        setCollection((current) => (current ? { ...current, count: Math.max(0, current.count - 1) } : current));
        setSelectedId((current) => (current === entryId ? null : current));
      } else {
        setItems((prev) => prev.map((e) => (e.id === entryId ? { ...e, collections: e.collections.filter((c) => c.id !== chip.id) } : e)));
      }
      reloadMine();
    });
  }, [attempt, id, reloadMine]);

  /** «+»: the post enters the theme by hand and never leaves it. The chip appears on the row. */
  const addToCollection = useCallback(async (entryId: string, target: CollectionListItem) => {
    await attempt(async () => {
      await addEntryToCollection(target.id, entryId);
      setItems((prev) => prev.map((e) => (e.id === entryId ? { ...e, collections: [...e.collections.filter((c) => c.id !== target.id), { id: target.id, name: target.name }] } : e)));
      reloadMine();
    });
  }, [attempt, reloadMine]);

  const onDeleted = useCallback(() => {
    setItems((prev) => prev.filter((e) => e.id !== selectedId));
    setTotal((n) => Math.max(0, n - 1));
    setSelectedId(null);
  }, [selectedId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    if (menuOpen) closeMenu();
    else if (panel) setPanel(null);
  };

  if (loading && !answer) {
    return (
      <div className="list-page list-page--library collection-page">
        <div className="list-page-content">
          <div className="journal-loading"><span className="spinner" /><p>{t.loading}</p></div>
        </div>
      </div>
    );
  }

  if (gone) {
    return (
      <div className="list-page list-page--library collection-page">
        <div className="list-page-content">
          <div className="list-page-empty collection-gone">
            <p>{t.collectionGone}</p>
            <Link to="/collections" className="library-load-btn">{t.collectionGoneBack}</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!answer || !collection) {
    return (
      <div className="list-page list-page--library collection-page">
        <div className="list-page-content">
          <div className="home-error" role="alert">
            <p>{t.collectionLoadFailed}</p>
            <button type="button" onClick={() => void loadPage(0, false)}>{t.libRetry}</button>
          </div>
        </div>
      </div>
    );
  }

  const views = collection.views;
  const view: CollectionView = chosenView && views.includes(chosenView) ? chosenView : collection.defaultView;
  const viewNames: Record<CollectionView, string> = { grid: t.collectionViewGrid, list: t.collectionViewList, play: t.collectionViewPlay };
  const isTheme = collection.kind === 'theme';
  const themes = mine.filter((c) => c.kind === 'theme');
  const otherThemes = themes.filter((c) => c.id !== collection.id);
  const hasMore = items.length < total;

  const loadMore = hasMore && (
    <div className="library-load-more">
      <button type="button" className="library-load-btn" disabled={loadingMore} onClick={() => void loadPage(items.length, true)}>
        {loadingMore ? <span className="spinner" /> : t.collectionLoadMore}
      </button>
    </div>
  );

  return (
    <div className="list-page list-page--library links-page collection-page" onKeyDown={onKeyDown}>
      <div className="list-page-content">
        <div className="list-page-header library-header collection-header">
          <div className="library-header-text">
            <Link to="/collections" className="list-page-back">← {t.collectionsTitle}</Link>
            <h1>
              {collection.name}
              {collection.isNew && <span className="collection-new">{t.collectionNew}</span>}
            </h1>
            <p className="library-count">{interpolate(t.collectionPosts, { count: collection.count })}</p>
          </div>
          <div className="collection-actions">
            {views.length > 1 && (
              <SegmentedControl
                label={t.collectionViewLabel}
                value={view}
                options={views.map((v) => ({ value: v, label: viewNames[v] }))}
                onChange={setChosenView}
              />
            )}
            {isTheme && (
              <div className="collection-menu">
                <button type="button" className="collection-menu-btn" aria-label={t.collectionMenu} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>⋯</button>
                {menuOpen && (
                  <div className="collection-menu-list" role="menu">
                    <button type="button" role="menuitem" onClick={startRename}>{t.collectionRename}</button>
                    <button type="button" role="menuitem" onClick={startMerge}>{t.collectionMerge}</button>
                    <button type="button" role="menuitem" onClick={hide}>{t.collectionHide}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {actionFailed && <p className="collection-action-error" role="alert">{t.collectionActionFailed}</p>}
        {failed && <p className="collection-action-error" role="alert">{t.collectionLoadFailed}</p>}

        {panel === 'rename' && (
          <form className="collection-panel collection-rename" onSubmit={submitRename}>
            <label>
              <span>{t.collectionRenameLabel}</span>
              <input type="text" value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} autoFocus />
            </label>
            <button type="submit" className="library-load-btn" disabled={!draft.trim() || draft.trim() === collection.name}>{t.collectionRenameSave}</button>
            <button type="button" className="collection-cancel" onClick={() => setPanel(null)}>{t.collectionCancel}</button>
          </form>
        )}

        {panel === 'merge' && (
          <div className="collection-panel collection-merge">
            {minesLoading ? (
              <span className="spinner" />
            ) : otherThemes.length === 0 ? (
              <p>{t.collectionMergeNone}</p>
            ) : (
              <div role="group" aria-label={t.collectionMergeInto} className="collection-merge-targets">
                {otherThemes.map((target) => (
                  <button key={target.id} type="button" className="collection-facet-chip" onClick={() => mergeInto(target.id)}>{target.name}</button>
                ))}
              </div>
            )}
            <button type="button" className="collection-cancel" onClick={() => setPanel(null)}>{t.collectionCancel}</button>
          </div>
        )}

        {answer.why.words.length > 0 && (
          <div className="collection-why">
            <button type="button" className="collection-why-btn" aria-expanded={whyOpen} onClick={() => setWhyOpen((open) => !open)}>{t.collectionWhy}</button>
            {whyOpen && (
              <>
                <p className="collection-why-words">{answer.why.words.join(' · ')}</p>
                {answer.why.entryIds.length > 0 && (
                  <div className="collection-why-posts">
                    <span className="collection-why-label">{t.collectionWhyPosts}</span>
                    {answer.why.entryIds.map((entryId) => <TypicalPost key={entryId} id={entryId} onOpen={setSelectedId} />)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <CollectionFacets facets={answer.facets} current={{ dove, fonte, quando }} onToggle={toggleFacet} />

        {view === 'play' && (
          <div className="collection-play">
            <button type="button" className="collection-play-all" disabled={playing} onClick={playAll}>
              {playing ? t.collectionPlayLoading : t.collectionPlayAll}
            </button>
          </div>
        )}

        {items.length === 0 ? (
          <div className="list-page-empty">{t.collectionNoPosts}</div>
        ) : (
          <EntriesView
            entries={items}
            mode={view === 'grid' ? 'wall' : 'studio'}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeleted={onDeleted}
            onRemoveChip={(entryId, chip) => void removeFromCollection(entryId, chip)}
            addTargets={themes}
            onAddChip={(entryId, target) => void addToCollection(entryId, target)}
            header={<VenueList venues={answer.venues} />}
            footer={loadMore}
          />
        )}
      </div>
    </div>
  );
}

/** The route `/collections/:id`: the body is made new when the id changes (after a merge the page of the other collection starts clean). */
export function CollectionPage() {
  const { id = '' } = useParams();
  return <CollectionBody key={id} id={id} />;
}
