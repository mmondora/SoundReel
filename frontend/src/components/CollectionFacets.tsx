import { useLanguage } from '../i18n';
import { platformLabel } from '../utils/platformLabel';
import type { CollectionFacets as Facets } from '../types';

/** «2026-10» → «ott 2026» / «Oct 2026». */
function formatMonth(month: string, lang: string): string {
  const [year, m] = month.split('-').map(Number);
  if (!year || !m) return month;
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export type FacetKey = 'dove' | 'fonte' | 'quando';

interface CollectionFacetsProps {
  facets: Facets;
  current: Record<FacetKey, string | undefined>;
  onToggle: (key: FacetKey, value: string) => void;
}

/** «Dove / Fonte / Quando»: the facets the server sent for the chosen collection; a tap narrows the posts, a second tap on the same one clears it. */
export function CollectionFacets({ facets, current, onToggle }: CollectionFacetsProps) {
  const { t, language } = useLanguage();
  const groups: Array<{ key: FacetKey; label: string; items: Array<{ value: string; label: string; count: number }> }> = [
    { key: 'dove', label: t.collectionsFacetWhere, items: facets.places.map((p) => ({ value: p.name, label: p.name, count: p.count })) },
    { key: 'fonte', label: t.collectionsFacetSource, items: facets.sources.map((p) => ({ value: p.platform, label: platformLabel(p.platform), count: p.count })) },
    { key: 'quando', label: t.collectionsFacetWhen, items: facets.months.map((m) => ({ value: m.month, label: formatMonth(m.month, language), count: m.count })) },
  ];
  return (
    <div className="collection-facets">
      {groups.filter((g) => g.items.length > 0).map((g) => (
        <div key={g.key} className="collection-facet" role="group" aria-label={g.label}>
          <span className="collection-facet-label" aria-hidden="true">{g.label}</span>
          {g.items.map((item) => (
            <button key={item.value} type="button" className="collection-facet-chip" aria-pressed={current[g.key] === item.value} onClick={() => onToggle(g.key, item.value)}>
              <span>{item.label}</span><span className="collection-chip-count">{item.count}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
