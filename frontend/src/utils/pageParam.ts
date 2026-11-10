/** The most pages anyone could ask for: a silly number in the address is brought back to this (the page then clamps to the last one there is). */
const MAX_PAGE = 1_000_000;

/** `?pagina=3` → 3. Anything that is not a whole number from 1 up is the first page. */
export function pageFromParam(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1;
  const n = Number(raw);
  return n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}
