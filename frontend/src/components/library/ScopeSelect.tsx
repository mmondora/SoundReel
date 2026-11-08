import { useLanguage } from '../../i18n';
import type { LibraryScope, LibrarySearchCounts } from '../../types';
import { SCOPE_OPTIONS, scopeCount } from '../../utils/librarySearch';
import '../../styles/library.css';

/** The words for a scope, as the selector and the results say them. */
export function useScopeLabels(): Record<LibraryScope, string> {
  const { t } = useLanguage();
  return { songs: t.libScopeSongs, media: t.libScopeMedia, local: t.libScopeLocal, all: t.libScopeAll };
}

export interface ScopeSelectProps {
  value: LibraryScope;
  onChange: (scope: LibraryScope) => void;
  /** Matches per scope for the text now typed; null when there is nothing to count yet. */
  counts: LibrarySearchCounts | null;
}

/**
 * "Cerca in: Libreria · Media server · File locali · Tutto", each with the number of matches once there is a
 * search. A native select: it is labelled, keyboard-friendly and the best control on a phone.
 */
export function ScopeSelect({ value, onChange, counts }: ScopeSelectProps) {
  const { t } = useLanguage();
  const labels = useScopeLabels();
  return (
    <label className="lib-scope" title={t.libScopeTitle}>
      <span className="lib-scope-k">{t.libScopeLabel}</span>
      <select
        className="lib-scope-select"
        value={value}
        onChange={(e) => onChange(e.target.value as LibraryScope)}
      >
        {SCOPE_OPTIONS.map((scope) => (
          <option key={scope} value={scope}>
            {counts ? `${labels[scope]} (${scopeCount(counts, scope)})` : labels[scope]}
          </option>
        ))}
      </select>
    </label>
  );
}
