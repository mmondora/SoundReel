import { useState } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import { withPicked } from '../../utils/facetOptions';
import type { FacetOption } from '../../utils/facetOptions';
import '../../styles/choose.css';

export type { FacetOption };

export interface FacetGroupProps {
  legend: string;
  options: readonly FacetOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** How many chips to show; the rest go into a "More (n)…" select. Picked values always show as chips. */
  limit?: number;
  /** Words for a picked value the counts no longer mention (a decade picked as "1990" is "1990s"). */
  labelOf?: (value: string) => string;
}

/**
 * One heading of "Scegli cosa suonare" (tipo, anni, album, autore…): chips with the number of songs each would give,
 * toggled on and off, several at once (OR inside the heading). A value with nothing to offer under the other filters
 * disappears — unless it is picked, so it can be undone. A long list (hundreds of albums) shows its first chips and
 * keeps the rest in a native select, which is also the friendliest control on a phone.
 */
export function FacetGroup({ legend, options, selected, onToggle, limit = 12, labelOf }: FacetGroupProps) {
  const { t } = useLanguage();
  const [moreKey, setMoreKey] = useState(0); // remounts the select after a pick so it shows its placeholder again

  const visible = withPicked(options, selected, labelOf).filter((o) => o.count > 0 || selected.includes(o.value));
  if (visible.length === 0) return null;

  const chips = visible.filter((o, i) => i < limit || selected.includes(o.value));
  const shown = new Set(chips.map((o) => o.value));
  const rest = visible.filter((o) => !shown.has(o.value));

  return (
    <fieldset className="ch-facet">
      <legend>{legend}</legend>
      <div className="ch-chips">
        {chips.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={`ch-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(o.value)}
            >
              {o.label} <span className="ch-chip-count">{o.count}</span>
            </button>
          );
        })}
        {rest.length > 0 && (
          <select
            key={moreKey}
            className="ch-more-select"
            aria-label={interpolate(t.chMoreLabel, { legend })}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) onToggle(e.target.value);
              setMoreKey((n) => n + 1);
            }}
          >
            <option value="">{interpolate(t.chMoreOf, { n: rest.length })}</option>
            {rest.map((o) => (
              <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
            ))}
          </select>
        )}
      </div>
    </fieldset>
  );
}
