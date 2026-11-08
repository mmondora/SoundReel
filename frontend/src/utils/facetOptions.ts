/**
 * The chips of a facet heading (filters of the Playlist manager and of the player's "Scegli cosa suonare").
 *
 * The counts only know the values that still have songs under the OTHER filters; a value that is picked but has none
 * left (genres Rock OR Alternative, then a decade where Rock has nothing) is not among them — yet it must stay on
 * screen, with a 0, or the filter would be active and invisible, and impossible to undo from the chips.
 */
export interface FacetOption {
  value: string;
  label: string;
  /** Songs that match this value together with every OTHER filter. */
  count: number;
}

/** The options plus every picked value they do not mention (at the end, count 0). */
export function withPicked(
  options: readonly FacetOption[],
  selected: readonly string[],
  labelOf: (value: string) => string = (value) => value,
): FacetOption[] {
  const known = new Set(options.map((o) => o.value));
  const missing = selected.filter((v, i) => !known.has(v) && selected.indexOf(v) === i);
  return [...options, ...missing.map((value) => ({ value, label: labelOf(value), count: 0 }))];
}
