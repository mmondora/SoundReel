import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageNav, pageSlots } from './PageNav';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';

// The numbers of the pages of a long list (Michele, 10 November: «la paginazione con 30 o 40 per pagina»): 1 … 6 [7] 8 … 43, a button for each, the
// current one marked, «previous» and «next» at the ends. The number of slots stays the same wherever the current page is, so the bar does not jump.

const t = translations.en;

describe('the slots of the pages', () => {
  it('shows every page when there are few', () => {
    expect(pageSlots(1, 1)).toEqual([1]);
    expect(pageSlots(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageSlots(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('near the start it shows the first five, a gap and the last', () => {
    expect(pageSlots(1, 43)).toEqual([1, 2, 3, 4, 5, 'gap', 43]);
    expect(pageSlots(3, 43)).toEqual([1, 2, 3, 4, 5, 'gap', 43]);
    expect(pageSlots(4, 43)).toEqual([1, 2, 3, 4, 5, 'gap', 43]);
  });

  it('in the middle it shows the first, a gap, the page and its neighbours, a gap and the last', () => {
    expect(pageSlots(22, 43)).toEqual([1, 'gap', 21, 22, 23, 'gap', 43]);
    expect(pageSlots(5, 43)).toEqual([1, 'gap', 4, 5, 6, 'gap', 43]);
  });

  it('near the end it shows the first, a gap and the last five', () => {
    expect(pageSlots(43, 43)).toEqual([1, 'gap', 39, 40, 41, 42, 43]);
    expect(pageSlots(40, 43)).toEqual([1, 'gap', 39, 40, 41, 42, 43]);
  });

  it('always has seven slots once there are more than seven pages', () => {
    for (let page = 1; page <= 43; page += 1) expect(pageSlots(page, 43)).toHaveLength(7);
    for (let page = 1; page <= 8; page += 1) expect(pageSlots(page, 8)).toHaveLength(7);
  });

  it('a page outside the range is brought into it', () => {
    expect(pageSlots(0, 43)).toEqual(pageSlots(1, 43));
    expect(pageSlots(99, 43)).toEqual(pageSlots(43, 43));
  });
});

function renderNav(page: number, pageCount: number, onPage = vi.fn()) {
  render(<LanguageProvider><PageNav page={page} pageCount={pageCount} onPage={onPage} /></LanguageProvider>);
  return { onPage, nav: screen.getByRole('navigation', { name: t.pageNavLabel }) };
}

describe('the bar of the pages', () => {
  it('is a navigation with a button for each slot, the current page marked', () => {
    const { nav } = renderNav(22, 43);
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['‹', '1', '21', '22', '23', '43', '›']);
    expect(within(nav).getByRole('button', { name: t.pageGoTo.replace('{page}', '22') })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: t.pageGoTo.replace('{page}', '21') })).not.toHaveAttribute('aria-current');
    expect(nav.textContent).toContain('…');
  });

  it('a number goes to that page; «next» and «previous» one page', async () => {
    const { onPage, nav } = renderNav(22, 43);
    await userEvent.click(within(nav).getByRole('button', { name: t.pageGoTo.replace('{page}', '43') }));
    expect(onPage).toHaveBeenLastCalledWith(43);
    await userEvent.click(within(nav).getByRole('button', { name: t.pageNext }));
    expect(onPage).toHaveBeenLastCalledWith(23);
    await userEvent.click(within(nav).getByRole('button', { name: t.pagePrev }));
    expect(onPage).toHaveBeenLastCalledWith(21);
  });

  it('«previous» is off on the first page and «next» on the last', () => {
    const first = renderNav(1, 5);
    expect(within(first.nav).getByRole('button', { name: t.pagePrev })).toBeDisabled();
    expect(within(first.nav).getByRole('button', { name: t.pageNext })).toBeEnabled();
  });

  it('«next» is off on the last page', () => {
    const { nav } = renderNav(5, 5);
    expect(within(nav).getByRole('button', { name: t.pageNext })).toBeDisabled();
    expect(within(nav).getByRole('button', { name: t.pagePrev })).toBeEnabled();
  });

  it('the page that is already open does nothing when it is pressed again', async () => {
    const { onPage, nav } = renderNav(3, 5);
    await userEvent.click(within(nav).getByRole('button', { name: t.pageGoTo.replace('{page}', '3') }));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('has nothing to draw when everything fits in one page', () => {
    const { container } = render(<LanguageProvider><PageNav page={1} pageCount={1} onPage={vi.fn()} /></LanguageProvider>);
    expect(container.firstChild).toBeNull();
  });

  it('says «page X of Y» in words too (the phone shows only that)', () => {
    const { nav } = renderNav(7, 43);
    expect(within(nav).getByText(t.pageOf.replace('{page}', '7').replace('{total}', '43'))).toBeVisible();
  });

  it('a page outside the range is shown as the nearest one (page 0 is the first, page 99 of 5 is the last)', () => {
    const low = renderNav(0, 5);
    expect(within(low.nav).getByRole('button', { name: t.pageGoTo.replace('{page}', '1') })).toHaveAttribute('aria-current', 'page');
    expect(within(low.nav).getByRole('button', { name: t.pagePrev })).toBeDisabled();
    expect(within(low.nav).getByText(t.pageOf.replace('{page}', '1').replace('{total}', '5'))).toBeVisible();
  });

  it('a page above the last is shown as the last, and «next» is off', () => {
    const { nav } = renderNav(99, 5);
    expect(within(nav).getByRole('button', { name: t.pageGoTo.replace('{page}', '5') })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: t.pageNext })).toBeDisabled();
  });
});
