import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Rail, formatCount } from './Rail';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import type { JournalStats } from '../../types';

// The left menu of the shell (A direction, spec 2026-11-10-web-look-and-feel-rethink-design.md): the sections of the site with their
// counts, the current one marked. It used to be the row of links of the old header.

const STATS: JournalStats = { totalEntries: 1721, totalSongs: 943, totalFilms: 731, totalNotes: 6143, totalSoftware: 1370 };

function renderRail(path: string, stats: JournalStats | null = STATS) {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <Rail stats={stats} />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setStoredLanguage('it');
});

describe('Rail', () => {
  it('lists every section of the site, in two groups, each a link to its page', () => {
    renderRail('/');
    const nav = screen.getByRole('navigation', { name: 'Sezioni' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/', '/collections', '/entries', '/songs', '/films', '/software', '/notes', '/player', '/playlist-manager', '/stats',
    ]);
    expect(within(nav).getByText('Archivio')).toBeInTheDocument();
    expect(within(nav).getByText('Ascolto')).toBeInTheDocument();
  });

  it('«Raccolte» sits between the Inbox and Link (spec §6.2), with no count of its own', () => {
    renderRail('/');
    const nav = screen.getByRole('navigation', { name: 'Sezioni' });
    const names = within(nav).getAllByRole('link').slice(0, 3).map((a) => a.textContent ?? '');
    expect(names[0]).toMatch(/Inbox/);
    expect(names[1]).toMatch(/Raccolte/);
    expect(names[2]).toMatch(/Link/);
    expect(screen.getByRole('link', { name: /Raccolte/ })).not.toHaveTextContent(/\d/);
  });

  it('«Raccolte» is the current page on /collections and on one collection, and the Inbox is not', () => {
    renderRail('/collections/type%3Amusic');
    expect(screen.getByRole('link', { name: /Raccolte/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
  });

  it('shows the counts of the journal the way the old header did: 943, 1,7k, 6,1k', () => {
    renderRail('/');
    expect(screen.getByRole('link', { name: /Link/ })).toHaveTextContent('1,7k');
    expect(screen.getByRole('link', { name: /canzoni/i })).toHaveTextContent('943');
    expect(screen.getByRole('link', { name: /film/i })).toHaveTextContent('731');
    expect(screen.getByRole('link', { name: /software/i })).toHaveTextContent('1,4k');
    expect(screen.getByRole('link', { name: /note/i })).toHaveTextContent('6,1k');
  });

  it('shows no count while the numbers are not there yet, and no count for the pages that have none', () => {
    renderRail('/', null);
    const nav = screen.getByRole('navigation', { name: 'Sezioni' });
    expect(within(nav).queryByText('943')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Player/ })).not.toHaveTextContent(/\d/);
  });

  it('marks the current page, and only it: the Inbox is the Inbox only at «/»', () => {
    renderRail('/songs');
    expect(screen.getByRole('link', { name: /canzoni/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page')).toHaveLength(1);
  });

  it('a page inside a section keeps the section marked (/entries/… is still Link)', () => {
    renderRail('/entries');
    expect(screen.getByRole('link', { name: /Link/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
  });

  it('writes the big numbers short: 999, 1,0k, 12k (above 10 000 no decimal), and nothing for a number that is not there', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1,0k');
    expect(formatCount(1721)).toBe('1,7k');
    expect(formatCount(12000)).toBe('12k');
    expect(formatCount(25400)).toBe('25k');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(undefined)).toBe('');
    expect(formatCount(null)).toBe('');
  });

  it('a section with ZERO things shows «0», not nothing (a count of zero is a count)', () => {
    renderRail('/', { ...STATS, totalFilms: 0 });
    // in its own count element (a bare «0» in the link is what `count && …` would draw)
    expect(screen.getByRole('link', { name: /film/i }).querySelector('.shell-nav-count')).toHaveTextContent(/^0$/);
  });

  it('speaks English when the language is English', () => {
    setStoredLanguage('en');
    renderRail('/');
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Listen')).toBeInTheDocument();
  });
});
