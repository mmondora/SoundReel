import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollectionChips, isPlaceholderTag, visibleTags } from './CollectionChips';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import type { CollectionChip, CollectionListItem } from '../types';

// The chips of a card (spec §6.5): the collections the post is in first (≤ 2 of theme and the place, the SERVER chose them), then the real tags, at
// most four in all. The placeholder tags the model copied from its prompt (`#tag`, `@utente`, `#hashtag`) are never shown. A «×» on a theme chip is
// «non è questo»: the post leaves that collection and does not come back (the place and the types are computed, they have no ×).

const t = translations.en;
const THEME: CollectionChip = { id: 'abc-123', name: 'Vino' };
const THEME2: CollectionChip = { id: 'def-456', name: 'Ristoranti' };
const PLACE: CollectionChip = { id: 'place:milano', name: 'Milano' };

function renderChips(props: Partial<Parameters<typeof CollectionChips>[0]> = {}) {
  return render(
    <LanguageProvider><MemoryRouter><CollectionChips chips={[]} tags={[]} {...props} /></MemoryRouter></LanguageProvider>,
  );
}

describe('placeholder tags', () => {
  it.each(['#tag', '#Tag', 'tag', '@utente', '@Utente', '#hashtag', 'hashtag', '  #tag  '])('%s is a placeholder', (tag) => {
    expect(isPlaceholderTag(tag)).toBe(true);
  });

  it.each(['#vino', '#tagliatelle', '@mario', 'utenti', '#ai', 'tagline'])('%s is a real tag', (tag) => {
    expect(isPlaceholderTag(tag)).toBe(false);
  });

  it('visibleTags drops the placeholders and the empty ones, keeps the order, and stops at the number asked', () => {
    expect(visibleTags(['#tag', '#vino', '', '@utente', '#cantina', '#hashtag', '#barolo'], 2)).toEqual(['#vino', '#cantina']);
    expect(visibleTags(undefined, 4)).toEqual([]);
  });
});

describe('the chips of a post', () => {
  it('shows the collections first (as links to the Link page filtered on them), then the real tags', () => {
    renderChips({ chips: [THEME, PLACE], tags: ['#tag', '#barolo', '@utente', '#cantina'] });
    const group = screen.getByRole('group', { name: t.collectionChipsLabel });
    expect(within(group).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/entries?raccolta=abc-123', '/entries?raccolta=place%3Amilano']);
    expect(group.textContent).toBe('VinoMilano#barolo#cantina');
  });

  it('shows at most four chips in all: the collections count first, the tags fill what is left', () => {
    renderChips({ chips: [THEME, THEME2, PLACE], tags: ['#a', '#b', '#c'] });
    expect(screen.getByRole('group', { name: t.collectionChipsLabel }).textContent).toBe('VinoRistorantiMilano#a');
    renderChips({ chips: [], tags: ['#a', '#b', '#c', '#d', '#e'] });
    expect(screen.getAllByRole('group')[1].textContent).toBe('#a#b#c#d');
  });

  it('shows at most four chips even when the post is in more collections than that (and then no tag)', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase() }));
    renderChips({ chips: many, tags: ['#vino'] });
    expect(screen.getByRole('group', { name: t.collectionChipsLabel }).textContent).toBe('ABCD');
  });

  it('nothing to show: nothing drawn', () => {
    const { container } = renderChips({ chips: [], tags: ['#tag', '@utente'] });
    expect(container.firstChild).toBeNull();
  });

  it('a post from an older server (no chips) still shows its tags', () => {
    renderChips({ chips: undefined, tags: ['#vino'] });
    expect(screen.getByText('#vino')).toBeInTheDocument();
  });

  it('a tag is text, not a link', () => {
    renderChips({ chips: [], tags: ['#vino'] });
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('«not this one»', () => {
  it('a theme chip has a ×, named after the collection, that reports that chip', async () => {
    const onRemove = vi.fn();
    renderChips({ chips: [THEME, THEME2], tags: [], onRemove });
    await userEvent.click(screen.getByRole('button', { name: t.collectionChipRemove.replace('{name}', 'Ristoranti') }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(THEME2);
  });

  it('the place and the types have no ×: they are computed, they cannot be corrected', () => {
    renderChips({ chips: [PLACE, { id: 'type:music', name: 'Musica' }], tags: [], onRemove: () => undefined });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('without a handler there is no × at all (the wall, where the card is a button itself)', () => {
    renderChips({ chips: [THEME], tags: [] });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('static: no links and no buttons (inside a card that is itself a button)', () => {
    renderChips({ chips: [THEME, PLACE], tags: ['#barolo'], onRemove: () => undefined, interactive: false });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Vino')).toBeInTheDocument();
  });
});

// «+» is «add to…»: the post enters a collection by hand and never leaves it (the server remembers it). It lists the collections of the user that can be
// corrected (the themes) and that the post is not in yet.

const target = (id: string, name: string): CollectionListItem => ({ id, name, kind: 'theme', group: null, parentId: null, count: 9, isNew: false, thumbs: [], views: ['grid'], defaultView: 'grid' });
const TARGETS = [target('abc-123', 'Vino'), target('xyz-1', 'Casa e design'), target('ghi-2', 'Ricette')];

describe('«add to a collection»', () => {
  it('is a «+» button when the card is given the collections to add to and what to do', () => {
    renderChips({ chips: [THEME], addTargets: TARGETS, onAdd: vi.fn() });
    expect(screen.getByRole('button', { name: t.collectionChipAdd })).toHaveAttribute('aria-haspopup', 'menu');
  });

  it.each([
    ['no handler', { addTargets: TARGETS }],
    ['no collections to add to', { addTargets: [], onAdd: vi.fn() }],
    ['a card that is a button itself (static)', { addTargets: TARGETS, onAdd: vi.fn(), interactive: false }],
  ])('has no «+» with %s', (_name, props) => {
    renderChips({ chips: [THEME], ...props });
    expect(screen.queryByRole('button', { name: t.collectionChipAdd })).toBeNull();
  });

  it('is the only chip of a post that has nothing else: it is the way to put the post somewhere', () => {
    renderChips({ chips: [], tags: [], addTargets: TARGETS, onAdd: vi.fn() });
    expect(screen.getByRole('button', { name: t.collectionChipAdd })).toBeInTheDocument();
  });

  it('opens a menu of the collections the post is not in yet: «Wine» is already a chip, so it is not offered', async () => {
    renderChips({ chips: [THEME], addTargets: TARGETS, onAdd: vi.fn() });
    const plus = screen.getByRole('button', { name: t.collectionChipAdd });
    expect(plus).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(plus);
    expect(plus).toHaveAttribute('aria-expanded', 'true');
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Casa e design', 'Ricette']);
  });

  it('choosing one reports that collection and closes the menu', async () => {
    const onAdd = vi.fn();
    renderChips({ chips: [THEME], addTargets: TARGETS, onAdd });
    await userEvent.click(screen.getByRole('button', { name: t.collectionChipAdd }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Ricette' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(TARGETS[2]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes the menu, and a click anywhere else does too', async () => {
    renderChips({ chips: [THEME], addTargets: TARGETS, onAdd: vi.fn() });
    const plus = screen.getByRole('button', { name: t.collectionChipAdd });
    await userEvent.click(plus);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(plus);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the chips are marked while the menu is open, so the page can lift them above the rows below', async () => {
    renderChips({ chips: [THEME], addTargets: TARGETS, onAdd: vi.fn() });
    const group = screen.getByRole('group', { name: t.collectionChipsLabel });
    expect(group).not.toHaveClass('has-menu-open');
    await userEvent.click(screen.getByRole('button', { name: t.collectionChipAdd }));
    expect(group).toHaveClass('has-menu-open');
    await userEvent.keyboard('{Escape}');
    expect(group).not.toHaveClass('has-menu-open');
  });

  it('has no «+» when the post is already in every collection there is', () => {
    renderChips({ chips: [THEME], addTargets: [TARGETS[0]], onAdd: vi.fn() });
    expect(screen.queryByRole('button', { name: t.collectionChipAdd })).toBeNull();
  });

  it('the «+» comes after the chips and the tags, and counts as none of the four', () => {
    renderChips({ chips: [THEME, THEME2, PLACE], tags: ['#a', '#b'], addTargets: TARGETS, onAdd: vi.fn() });
    const group = screen.getByRole('group', { name: t.collectionChipsLabel });
    expect(group.textContent).toBe('VinoRistorantiMilano#a+');
  });
});
