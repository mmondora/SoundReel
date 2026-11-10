import { interpolate, useLanguage } from '../i18n';
import '../styles/pagenav.css';

// The pages of a long list (Michele, 10 November: «la paginazione con 30 o 40 per pagina», spec 2026-11-10-web-look-and-feel-rethink-design.md §3.6):
// 1 … 6 [7] 8 … 43, a button for each, the current one marked, «previous» and «next» at the ends. Once there are more than seven pages the bar always
// has seven slots wherever the current page is, so it does not jump while the person goes through them. The page and the total are the SERVER's (rule P).

const BOUNDARY = 1;
const SIBLINGS = 1;
/** The most slots drawn: the first, the last, the page and its neighbours, and the two gaps. */
const SLOTS = BOUNDARY * 2 + SIBLINGS * 2 + 3;

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** What the bar draws: page numbers and `'gap'` (the «…»). A page outside 1..count is brought into it. */
export function pageSlots(page: number, count: number): Array<number | 'gap'> {
  const total = Math.max(1, Math.floor(count));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  if (total <= SLOTS) return range(1, total);
  const start = range(1, BOUNDARY);
  const end = range(total - BOUNDARY + 1, total);
  const siblingsStart = Math.max(Math.min(current - SIBLINGS, total - BOUNDARY - SIBLINGS * 2 - 1), BOUNDARY + 2);
  const siblingsEnd = Math.min(Math.max(current + SIBLINGS, BOUNDARY + SIBLINGS * 2 + 2), end[0] - 2);
  return [
    ...start,
    ...(siblingsStart > BOUNDARY + 2 ? (['gap'] as const) : [BOUNDARY + 1]),
    ...range(siblingsStart, siblingsEnd),
    ...(siblingsEnd < total - BOUNDARY - 1 ? (['gap'] as const) : [total - BOUNDARY]),
    ...end,
  ];
}

export interface PageNavProps {
  /** The page shown, from 1. */
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}

export function PageNav({ page, pageCount, onPage }: PageNavProps) {
  const { t } = useLanguage();
  if (pageCount <= 1) return null;
  const current = Math.min(Math.max(1, page), pageCount);
  return (
    <nav className="page-nav" aria-label={t.pageNavLabel}>
      <button type="button" className="page-nav-btn page-nav-step" aria-label={t.pagePrev} disabled={current <= 1} onClick={() => onPage(current - 1)}>‹</button>
      {pageSlots(current, pageCount).map((slot, i) =>
        slot === 'gap' ? (
          <span key={`gap-${i}`} className="page-nav-gap" aria-hidden="true">…</span>
        ) : (
          <button
            key={slot}
            type="button"
            className={`page-nav-btn page-nav-num${slot === current ? ' is-current' : ''}`}
            aria-label={interpolate(t.pageGoTo, { page: slot })}
            aria-current={slot === current ? 'page' : undefined}
            onClick={() => { if (slot !== current) onPage(slot); }}
          >
            {slot}
          </button>
        ),
      )}
      <button type="button" className="page-nav-btn page-nav-step" aria-label={t.pageNext} disabled={current >= pageCount} onClick={() => onPage(current + 1)}>›</button>
      <span className="page-nav-status">{interpolate(t.pageOf, { page: current, total: pageCount })}</span>
    </nav>
  );
}
