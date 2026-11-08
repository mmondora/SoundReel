import { interpolate, useLanguage } from '../../i18n';
import type { LibraryHit, LibraryScope } from '../../types';
import type { LibrarySearch } from '../../hooks/useLibrarySearch';
import { elsewhere, formatBytes, groupHits, canSearch, scopeCount, searchFailure } from '../../utils/librarySearch';
import { CopyButton } from '../manager/CopyButton';
import { useScopeLabels } from './ScopeSelect';
import '../../styles/library.css';

function HitRow({ hit, locale }: { hit: LibraryHit; locale: string }) {
  const { t } = useLanguage();
  const labels = useScopeLabels();
  const size = formatBytes(hit.bytes, locale);
  const who = hit.artist ? `${hit.artist} – ${hit.title}` : hit.title;
  return (
    <li className="lib-hit" data-scope={hit.scope}>
      <div className="lib-hit-main">
        <span className={`lib-badge lib-badge-${hit.scope}`}>{labels[hit.scope]}</span>
        <span className="lib-hit-title">
          {hit.artist && <span className="lib-hit-artist">{hit.artist}</span>}
          {hit.artist && ' – '}
          <span>{hit.title}</span>
        </span>
        {hit.inJournal && hit.scope !== 'songs' && (
          <span className="lib-mark" title={t.libInJournalTitle}>{t.libInJournal}</span>
        )}
        {size && <span className="lib-hit-size">{size}</span>}
      </div>
      {(hit.album || hit.scope === 'local') && (
        <div className="lib-hit-meta">
          {hit.album && <span className="lib-hit-album">{hit.album}</span>}
          {hit.scope === 'local' && hit.folder && <span className="lib-hit-folder">{hit.folder}</span>}
        </div>
      )}
      {hit.location && (
        <div className="lib-hit-where">
          <code className="lib-hit-location">{hit.location}</code>
          <CopyButton
            value={hit.location}
            what={`${who}: ${hit.scope === 'media' ? t.libCopyUrl : t.libCopyPath}`}
          />
        </div>
      )}
    </li>
  );
}

export interface LibrarySearchResultsProps {
  search: LibrarySearch;
  scope: LibraryScope;
  /** What is typed in the search box (the panel explains what it needs when that is too short). */
  text: string;
  onScope: (scope: LibraryScope) => void;
}

/**
 * The answer to a library search: where the songs are (path or URL, copyable), never a way to play or import them
 * (rule L6). Grouped per place when the scope is "all".
 */
export function LibrarySearchResults({ search, scope, text, onScope }: LibrarySearchResultsProps) {
  const { t, language } = useLanguage();
  const labels = useScopeLabels();
  const locale = language === 'it' ? 'it-IT' : 'en-GB';

  if (!canSearch(text)) {
    return <p className="lib-note" data-state="idle">{t.libMinChars}</p>;
  }

  if (search.status === 'error' && search.error) {
    const failure = searchFailure(search.error);
    const message =
      failure === 'forbidden' ? t.libErrForbidden
        : failure === 'network' ? t.libErrNetwork
          : failure === 'tooShort' || failure === 'scope' ? t.libErrInvalid
            : t.libErrServer;
    return (
      <div className="lib-error" role="alert" data-state="error">
        <span>{message}</span>
        <button type="button" className="lib-retry" onClick={search.retry}>{t.libRetry}</button>
      </div>
    );
  }

  if (!search.data) {
    return (
      <p className="lib-note" role="status" data-state="loading">
        <span className="spinner" aria-hidden /> {t.libSearching}
      </p>
    );
  }

  const { data } = search;
  const groups = groupHits(data, scope);
  const count = scopeCount(data.counts, scope);
  const summary = scope === 'all'
    ? interpolate(t.libSummaryAll, { songs: data.counts.songs, media: data.counts.media, local: data.counts.local })
    : count === 1
      ? interpolate(t.libSummarySingle, { scope: labels[scope] })
      : interpolate(t.libSummaryOne, { n: count, scope: labels[scope] });
  const others = elsewhere(data.counts, scope);
  const busy = search.status === 'waiting' || search.status === 'loading';

  return (
    <section
      className={`lib-results${search.stale ? ' is-stale' : ''}`}
      aria-label={t.libResultsLabel}
      aria-busy={busy}
      data-state={search.stale ? 'stale' : 'ready'}
    >
      <p className="lib-summary" role="status" data-testid="lib-summary">{count === 0 ? interpolate(t.libNone, { q: data.q, scope: labels[scope] }) : summary}</p>
      <p className="lib-note lib-info-only">{t.libInfoOnly}</p>

      {count === 0 && others.length > 0 && (
        <p className="lib-elsewhere">
          {t.libElsewhere}{' '}
          {others.map((o, i) => (
            <span key={o.scope}>
              {i > 0 && ' · '}
              <button type="button" className="lib-link" onClick={() => onScope(o.scope)}>
                {labels[o.scope]} ({o.count})
              </button>
            </span>
          ))}
        </p>
      )}

      {groups.map((group) => (
        <div key={group.scope} className="lib-group" data-group={group.scope}>
          {scope === 'all' && (
            <h3 className="lib-group-title">
              {labels[group.scope]} <span className="lib-group-count">{group.total}</span>
            </h3>
          )}
          {group.total > group.hits.length && (
            <p className="lib-note lib-capped">
              {interpolate(t.libShownOf, { shown: group.hits.length, total: group.total })}
            </p>
          )}
          <ul className="lib-list">
            {group.hits.map((hit) => (
              <HitRow key={`${hit.scope}|${hit.location ?? hit.songKey}`} hit={hit} locale={locale} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
