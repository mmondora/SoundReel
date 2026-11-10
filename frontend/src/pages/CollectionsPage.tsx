import { useEffect, useMemo, useState } from 'react';
import { CollectionCard } from '../components/CollectionCard';
import { useCollections } from '../hooks/useCollections';
import { useLanguage } from '../i18n';
import { fetchMe, unhideCollection } from '../services/api';
import type { CollectionListItem } from '../types';

// The page «Raccolte» (spec 2026-11-09-library-collections-auto-topics-design.md §6.2 B): the way to browse and to see what the system found. Cards with
// a 2×2 mosaic, grouped under the headings the SERVER sent (in the order they first appear, «Other» last), a strip with the new ones, a field that
// filters by name, and at the bottom the hidden ones (to bring them back) and, for an administrator, the ones under observation. The page draws.

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface Group {
  heading: string | null;
  items: CollectionListItem[];
}

/** The headings in the order they first appear in the list the server sent; the collections with no heading come last. */
function groupByHeading(list: CollectionListItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of list) {
    const found = groups.find((g) => g.heading === item.group);
    if (found) found.items.push(item);
    else groups.push({ heading: item.group, items: [item] });
  }
  return [...groups.filter((g) => g.heading !== null), ...groups.filter((g) => g.heading === null)];
}

function HiddenCollections({ onBroughtBack }: { onBroughtBack: () => void }) {
  const { t } = useLanguage();
  const { collections, loading, reload } = useCollections('hidden');
  if (loading) return <div className="journal-loading"><span className="spinner" /></div>;
  return (
    <ul className="collections-hidden-list">
      {collections.map((c) => (
        <li key={c.id}>
          <span>{c.name}</span>
          <button
            type="button"
            aria-label={`${t.collectionUnhide}: ${c.name}`}
            onClick={() => { void unhideCollection(c.id).then(() => { reload(); onBroughtBack(); }); }}
          >
            {t.collectionUnhide}
          </button>
        </li>
      ))}
    </ul>
  );
}

function WatchingCollections() {
  const { collections, loading } = useCollections('watching');
  if (loading) return <div className="journal-loading"><span className="spinner" /></div>;
  return (
    <ul className="collections-hidden-list">
      {collections.map((c) => (
        <li key={c.id}><span>{c.name}</span><span className="collections-watching-count">{c.count}</span></li>
      ))}
    </ul>
  );
}

export function CollectionsPage() {
  const { t } = useLanguage();
  const { collections, loading, failed, reload } = useCollections();
  const [filter, setFilter] = useState('');
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [watchingOpen, setWatchingOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let current = true;
    fetchMe().then((me) => { if (current) setIsAdmin(me.isAdmin); }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  const shown = useMemo(() => {
    const needle = fold(filter.trim());
    return needle ? collections.filter((c) => fold(c.name).includes(needle)) : collections;
  }, [collections, filter]);
  const fresh = useMemo(() => shown.filter((c) => c.isNew), [shown]);
  const groups = useMemo(() => groupByHeading(shown), [shown]);

  return (
    <div className="list-page collections-page">
      <div className="list-page-content">
        <div className="list-page-header collections-header">
          <h1>{t.collectionsTitle}</h1>
          <input
            type="search"
            className="collections-filter"
            role="searchbox"
            placeholder={t.collectionsFilter}
            aria-label={t.collectionsFilter}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="journal-loading"><span className="spinner" /><p>{t.loading}</p></div>
        ) : failed ? (
          <div className="home-error" role="alert">
            <p>{t.collectionsLoadFailed}</p>
            <button type="button" onClick={reload}>{t.libRetry}</button>
          </div>
        ) : collections.length === 0 ? (
          <div className="list-page-empty">
            <p>{t.collectionsEmpty}</p>
            <p className="collections-hint">{t.collectionsEmptyHint}</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="list-page-empty">{t.collectionsNoMatch}</div>
        ) : (
          <>
            {fresh.length > 0 && (
              <section className="collections-group collections-new-strip" aria-labelledby="collections-new">
                <h2 id="collections-new">{t.collectionsNewStrip}</h2>
                <div className="collections-grid">{fresh.map((c) => <CollectionCard key={c.id} collection={c} />)}</div>
              </section>
            )}
            {groups.map((g) => {
              const id = `collections-group-${g.heading ?? 'other'}`;
              return (
                <section key={id} className="collections-group" aria-labelledby={id}>
                  <h2 id={id}>{g.heading ?? t.collectionsOther}</h2>
                  <div className="collections-grid">{g.items.map((c) => <CollectionCard key={c.id} collection={c} />)}</div>
                </section>
              );
            })}
          </>
        )}

        {!loading && !failed && (
          <div className="collections-more">
            <button type="button" className="collections-disclose" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((v) => !v)}>
              {t.collectionsHidden}
            </button>
            {hiddenOpen && <HiddenCollections onBroughtBack={reload} />}
            {isAdmin && (
              <>
                <button type="button" className="collections-disclose" aria-expanded={watchingOpen} onClick={() => setWatchingOpen((v) => !v)}>
                  {t.collectionsWatching}
                </button>
                {watchingOpen && <WatchingCollections />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

