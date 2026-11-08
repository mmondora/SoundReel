import { useLanguage } from '../../i18n';
import type { LibraryScope, LibrarySearchCounts } from '../../types';
import { elsewhere } from '../../utils/librarySearch';
import { useScopeLabels } from './ScopeSelect';
import '../../styles/library.css';

/**
 * "No library song matches — found elsewhere: Media server (2) · Local files (41)". Shown under the search box when
 * the journal has nothing for the text but the other places do: the case that started this feature (songs
 * downloaded long ago that the journal never knew about).
 */
export function ElsewhereHint({
  counts,
  current,
  onPick,
}: {
  counts: LibrarySearchCounts;
  current: LibraryScope;
  onPick: (scope: LibraryScope) => void;
}) {
  const { t } = useLanguage();
  const labels = useScopeLabels();
  const others = elsewhere(counts, current);
  if (others.length === 0) return null;
  return (
    <p className="lib-elsewhere" data-testid="elsewhere-hint">
      {t.libNoSongsHere} {t.libElsewhere}{' '}
      {others.map((o, i) => (
        <span key={o.scope}>
          {i > 0 && ' · '}
          <button type="button" className="lib-link" onClick={() => onPick(o.scope)}>
            {labels[o.scope]} ({o.count})
          </button>
        </span>
      ))}
    </p>
  );
}
