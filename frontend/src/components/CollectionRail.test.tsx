import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollectionRail, RAIL_LIMIT } from './CollectionRail';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import type { CollectionListItem } from '../types';

// The rail of chips on top of «Link» (spec §6.1 A): «Tutte · Musica · Film · ✦ Vino · …». The server decided which collections there are and their
// order; the rail only draws them (at most 12, the rest is on the page «Raccolte»), and a tap says which one is chosen.

const t = translations.en;
const col = (id: string, name: string, count: number, over: Partial<CollectionListItem> = {}): CollectionListItem => ({
  id, name, kind: 'theme', group: null, parentId: null, count, isNew: false, thumbs: [], views: ['grid', 'list'], defaultView: 'grid', ...over,
});

function renderRail(collections: CollectionListItem[], selectedId: string | null = null, onSelect: (id: string | null) => void = () => undefined, allCount: number | null = 1696) {
  return render(
    <LanguageProvider><MemoryRouter><CollectionRail collections={collections} selectedId={selectedId} onSelect={onSelect} allCount={allCount} /></MemoryRouter></LanguageProvider>,
  );
}

const chipNames = () => screen.getAllByRole('button').map((b) => b.textContent ?? '');

describe('the rail of collections', () => {
  it('is «All» and then the collections in the order the server sent, each with its count', () => {
    renderRail([col('t:music', 'Musica', 719, { kind: 'type' }), col('u1', 'Vino', 15), col('u2', 'Casa e design', 10)]);
    expect(chipNames()).toEqual([`${t.collectionsAll}1,696`, 'Musica719', 'Vino15', 'Casa e design10']);
  });

  it('nothing to choose from: no rail at all (a library with no collections is the page as it was)', () => {
    const { container } = renderRail([]);
    expect(container.firstChild).toBeNull();
  });

  it('shows at most 12, and the rest is a link to the page «Raccolte»', () => {
    const many = Array.from({ length: 15 }, (_, i) => col(`u${i}`, `Tema ${i}`, 20 - i));
    renderRail(many);
    expect(RAIL_LIMIT).toBe(12);
    expect(screen.getAllByRole('button')).toHaveLength(1 + 12);                                      // «All» and twelve
    expect(screen.getByRole('link', { name: new RegExp(t.collectionsMore) })).toHaveAttribute('href', '/collections');
  });

  it('with 12 or fewer there is no «More» link', () => {
    renderRail(Array.from({ length: 12 }, (_, i) => col(`u${i}`, `Tema ${i}`, 5)));
    expect(screen.queryByRole('link', { name: new RegExp(t.collectionsMore) })).toBeNull();
  });

  it('marks the new ones', () => {
    renderRail([col('u1', 'Vino', 5, { isNew: true }), col('u2', 'Casa', 9)]);
    expect(within(screen.getByRole('button', { name: /Vino/ })).getByText(t.collectionNew)).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Casa/ })).queryByText(t.collectionNew)).toBeNull();
  });

  it('a tap chooses a collection; the chosen one is pressed; «All» is pressed when none is chosen', async () => {
    const onSelect = vi.fn();
    renderRail([col('u1', 'Vino', 15), col('u2', 'Casa', 10)], 'u2', onSelect);
    expect(screen.getByRole('button', { name: /Casa/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Vino/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: new RegExp(t.collectionsAll) })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: /Vino/ }));
    expect(onSelect).toHaveBeenCalledWith('u1');
  });

  it('a tap on the chosen one clears it, and «All» clears it', async () => {
    const onSelect = vi.fn();
    renderRail([col('u1', 'Vino', 15)], 'u1', onSelect);
    await userEvent.click(screen.getByRole('button', { name: /Vino/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.collectionsAll) }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('without a total «All» has no number', () => {
    renderRail([col('u1', 'Vino', 15)], null, () => undefined, null);
    expect(screen.getByRole('button', { name: t.collectionsAll })).toBeInTheDocument();
  });

  it('a chosen collection that is beyond the first 12 still shows, so the user sees what is filtering', () => {
    const many = Array.from({ length: 15 }, (_, i) => col(`u${i}`, `Tema ${i}`, 20 - i));
    renderRail(many, 'u14');
    expect(screen.getByRole('button', { name: /Tema 14/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is a labelled group', () => {
    renderRail([col('u1', 'Vino', 15)]);
    expect(screen.getByRole('group', { name: t.collectionsRailLabel })).toBeInTheDocument();
  });
});
