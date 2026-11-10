import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CollectionCard } from './CollectionCard';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';

// A card of a collection: a 2×2 mosaic of the pictures the SERVER sent, the name, how many posts, «New»; a link to the collection.

const t = translations.en;
const card = (over: Partial<Parameters<typeof CollectionCard>[0]['collection']> = {}) => render(
  <MemoryRouter><LanguageProvider><CollectionCard collection={{ id: 'wine', name: 'Wine', count: 15, isNew: false, thumbs: [], ...over }} /></LanguageProvider></MemoryRouter>,
);

describe('the card of a collection', () => {
  it('is a link to the collection, with the id encoded in the address', () => {
    card({ id: 'place:milano', name: 'Milano' });
    expect(screen.getByRole('link')).toHaveAttribute('href', '/collections/place%3Amilano');
  });

  it('says the name and how many posts, and «New» only when the server says it is', () => {
    const { unmount } = card();
    expect(screen.getByRole('link')).toHaveTextContent(`Wine${t.collectionPosts.replace('{count}', '15')}`);
    expect(screen.queryByText(t.collectionNew)).toBeNull();
    unmount();
    card({ isNew: true });
    expect(screen.getByText(t.collectionNew)).toBeInTheDocument();
  });

  it('draws four tiles, with the pictures the server sent and neutral tiles for the rest', () => {
    const { container } = card({ thumbs: ['https://img/a.jpg', 'https://img/b.jpg'] });
    expect(container.querySelectorAll('.collection-tile')).toHaveLength(4);
    expect(Array.from(container.querySelectorAll('.collection-tile img')).map((i) => i.getAttribute('src'))).toEqual(['https://img/a.jpg', 'https://img/b.jpg']);
  });

  it('with no picture at all the mosaic shows the first letter of the name, not four empty squares', () => {
    const { container } = card({ name: 'Viaggi', thumbs: [] });
    expect(container.querySelectorAll('.collection-tile')).toHaveLength(0);
    expect(container.querySelector('.collection-mosaic')).toHaveTextContent('V');
  });

  it('the letter is in capitals', () => {
    const { container } = card({ name: 'vino', thumbs: [] });
    expect(container.querySelector('.collection-mosaic')?.textContent).toBe('V');
  });
});
