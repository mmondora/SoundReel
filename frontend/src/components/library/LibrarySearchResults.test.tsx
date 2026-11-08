import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import { LibrarySearchResults } from './LibrarySearchResults';
import { ScopeSelect } from './ScopeSelect';
import type { LibrarySearch } from '../../hooks/useLibrarySearch';
import type { LibraryHit, LibraryScope, LibrarySearchResponse } from '../../types';

const MEDIA_URL = 'http://192.168.178.10:49152/Music/Bassi%20Maestro/Metropolis.mp3';
const LOCAL_PATH = '~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3';
const EXTRA_PATH = 'Rock/Bassi Maestro/Live/01 - Intro.mp3';

const SONGS_HIT: LibraryHit = { scope: 'songs', artist: 'Bassi Maestro', title: 'Fuori dal tunnel', album: 'Il Fuoriclasse', folder: 'Libreria', location: null, bytes: null, songKey: 'bassi maestro::fuori dal tunnel', inJournal: true };
const MEDIA_HIT: LibraryHit = { scope: 'media', artist: 'Bassi Maestro', title: 'Metropolis', album: 'Il Fuoriclasse', folder: 'Media server', location: MEDIA_URL, bytes: 5_123_456, songKey: 'bassi maestro::metropolis', inJournal: true };
const LOCAL_HIT: LibraryHit = { scope: 'local', artist: 'Bassi Maestro', title: 'Foto di gruppo', album: null, folder: 'Libreria (Spooty)', location: LOCAL_PATH, bytes: 5_123_456, songKey: 'bassi maestro::foto di gruppo', inJournal: false };
const EXTRA_HIT: LibraryHit = { scope: 'local', artist: '', title: 'Intro', album: 'Live', folder: 'Rock', location: EXTRA_PATH, bytes: 900, songKey: '::intro', inJournal: false };

function search(data: Partial<LibrarySearchResponse> | null, extra: Partial<LibrarySearch> = {}): LibrarySearch {
  return {
    status: data ? 'ready' : 'loading',
    query: 'bassi maestro',
    data: data ? { q: 'bassi maestro', scope: 'all', counts: { songs: 0, media: 0, local: 0 }, results: [], ...data } : null,
    stale: false,
    error: null,
    retry: vi.fn(),
    ...extra,
  };
}

const FULL = search({ counts: { songs: 1, media: 1, local: 2 }, results: [SONGS_HIT, MEDIA_HIT, LOCAL_HIT, EXTRA_HIT] });

function show(s: LibrarySearch, scope: LibraryScope = 'all', text = 'bassi maestro', onScope = vi.fn()) {
  render(
    <LanguageProvider>
      <LibrarySearchResults search={s} scope={scope} text={text} onScope={onScope} />
    </LanguageProvider>,
  );
  return onScope;
}
const row = (title: string) => screen.getByText(title).closest('li') as HTMLElement;
const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

beforeEach(() => setStoredLanguage('en'));
afterEach(() => { cleanup(); setClipboard(undefined); });

describe('a result (rule L3)', () => {
  it('shows the scope badge, "artist – title", the album and the size', () => {
    show(FULL, 'media');
    const media = row('Metropolis');
    expect(within(media).getByText('Media server')).toHaveClass('lib-badge-media');
    expect(media).toHaveTextContent('Bassi Maestro – Metropolis');
    expect(within(media).getByText('Il Fuoriclasse')).toBeInTheDocument();
    expect(within(media).getByText('4.9 MB')).toBeInTheDocument();
  });

  it('says the size with a decimal comma in Italian', () => {
    setStoredLanguage('it');
    show(FULL, 'media');
    expect(within(row('Metropolis')).getByText('4,9 MB')).toBeInTheDocument();
    expect(within(row('Metropolis')).getByText('già in libreria')).toBeInTheDocument();
  });

  it('a local file shows its folder (so an extra folder is told apart from Spooty’s) and a title without artist stands alone', () => {
    show(FULL, 'local');
    const extra = row('Intro');
    expect(extra).toHaveTextContent('Rock');
    expect(extra).not.toHaveTextContent('–');
    expect(within(row('Foto di gruppo')).getByText('Libreria (Spooty)')).toBeInTheDocument();
    expect(within(extra).getByText('900 B')).toBeInTheDocument();
  });

  it('shows where the file is: the media server URL or the path, as copyable text', () => {
    show(FULL, 'all');
    expect(within(row('Metropolis')).getByText(MEDIA_URL).tagName).toBe('CODE');
    expect(within(row('Foto di gruppo')).getByText(LOCAL_PATH).tagName).toBe('CODE');
    expect(within(row('Intro')).getByText(EXTRA_PATH)).toBeInTheDocument();
  });

  it('Copy copies exactly the location, and is named after the song and what it copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    show(FULL, 'all');
    const urlButton = within(row('Metropolis')).getByRole('button', { name: 'Copy Bassi Maestro – Metropolis: URL' });
    await act(async () => { fireEvent.click(urlButton); });
    expect(writeText).toHaveBeenLastCalledWith(MEDIA_URL);
    const pathButton = within(row('Foto di gruppo')).getByRole('button', { name: 'Copy Bassi Maestro – Foto di gruppo: path' });
    await act(async () => { fireEvent.click(pathButton); });
    expect(writeText).toHaveBeenLastCalledWith(LOCAL_PATH);
  });

  it('marks "already in the library" for files whose song is in the journal — and only there', () => {
    show(FULL, 'all');
    expect(within(row('Metropolis')).getByText('already in the library')).toBeInTheDocument();
    expect(within(row('Foto di gruppo')).queryByText('already in the library')).toBeNull();
    // a journal song needs no mark: its badge already says Library
    expect(within(row('Fuori dal tunnel')).queryByText('already in the library')).toBeNull();
  });

  it('a library (journal) result has no location line: it is not a file', () => {
    show(FULL, 'songs');
    const song = row('Fuori dal tunnel');
    expect(within(song).getByText('Library')).toHaveClass('lib-badge-songs');
    expect(song.querySelector('code')).toBeNull();
    expect(within(song).queryByRole('button')).toBeNull();
  });
});

describe('information only (rule L6)', () => {
  it('there is no play, import or add button anywhere: the only buttons are Copy', () => {
    show(FULL, 'all');
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^Copy /);
    expect(screen.queryByRole('button', { name: /play|import|add|ascolta|importa|aggiungi/i })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so in words', () => {
    show(FULL, 'all');
    expect(screen.getByText(/finding them does not import them into the library, nor play them/)).toBeInTheDocument();
  });
});

describe('scope and counts', () => {
  it('"Everything" groups per place with the total of each, and says the three counts', () => {
    show(FULL, 'all');
    expect(screen.getByTestId('lib-summary')).toHaveTextContent('Library 1 · Media server 1 · Local files 2');
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Library 1', 'Media server 1', 'Local files 2']);
  });

  it('one scope shows only its own results, without group headings, and counts them', () => {
    show(FULL, 'local');
    expect(screen.getByTestId('lib-summary')).toHaveTextContent('2 results in Local files');
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.queryByText('Metropolis')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('one result is singular', () => {
    show(FULL, 'media');
    expect(screen.getByTestId('lib-summary')).toHaveTextContent('1 result in Media server');
  });

  it('says how many there are beyond the limit', () => {
    show(search({ counts: { songs: 0, media: 0, local: 1532 }, results: [LOCAL_HIT, EXTRA_HIT] }), 'local');
    expect(screen.getByText('Showing the first 2 of 1532')).toBeInTheDocument();
    expect(screen.getByTestId('lib-summary')).toHaveTextContent('1532 results in Local files');
  });

  it('does not say "showing the first" when everything is shown', () => {
    show(FULL, 'all');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });
});

describe('empty, loading, short text and errors', () => {
  it('nothing in this scope: says so and points to where there is something (a click switches scope)', () => {
    const onScope = show(search({ counts: { songs: 0, media: 2, local: 41 }, results: [MEDIA_HIT] }), 'songs');
    expect(screen.getByTestId('lib-summary')).toHaveTextContent('No results for “bassi maestro” in Library.');
    fireEvent.click(screen.getByRole('button', { name: 'Local files (41)' }));
    expect(onScope).toHaveBeenCalledWith('local');
    expect(screen.getByRole('button', { name: 'Media server (2)' })).toBeInTheDocument();
  });

  it('nothing anywhere: no pointers', () => {
    show(search({ counts: { songs: 0, media: 0, local: 0 }, results: [] }), 'all');
    expect(screen.getByTestId('lib-summary')).toHaveTextContent('No results for “bassi maestro” in Everything.');
    expect(screen.queryByText('Found elsewhere:')).toBeNull();
  });

  it('too little text: asks for 2 characters instead of searching', () => {
    show(search(null), 'local', 'b');
    expect(screen.getByText('Type at least 2 characters to search the files.')).toBeInTheDocument();
  });

  it('first answer not here yet: "Searching…"', () => {
    show(search(null), 'local');
    expect(screen.getByRole('status')).toHaveTextContent('Searching…');
  });

  it('keeps the previous answer on screen, dimmed and busy, while a newer one loads', () => {
    show(search(FULL.data, { status: 'loading', stale: true }), 'all');
    const region = screen.getByRole('region', { name: 'Search results' });
    expect(region).toHaveClass('is-stale');
    expect(region).toHaveAttribute('aria-busy', 'true');
  });

  it.each([
    ['forbidden', { code: 'forbidden', index: null, status: 403, message: '' }, 'You are not allowed to search the files.'],
    ['network', { code: 'network', index: null, status: null, message: '' }, 'Server not reachable.'],
    ['server', { code: 'library search failed', index: null, status: 500, message: '' }, 'Search is not available right now.'],
    ['invalid', { code: 'invalid_scope', index: null, status: 400, message: '' }, 'Invalid search.'],
  ])('a %s failure is an alert with a working retry', (_name, error, text) => {
    const retry = vi.fn();
    show(search(null, { status: 'error', error, retry }), 'local');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(text);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('ScopeSelect', () => {
  function select(value: LibraryScope, counts: LibrarySearchResponse['counts'] | null, onChange = vi.fn()) {
    render(
      <LanguageProvider>
        <ScopeSelect value={value} onChange={onChange} counts={counts} />
      </LanguageProvider>,
    );
    return onChange;
  }

  it('is labelled, in the order Library · Media server · Local files · Everything', () => {
    select('songs', null);
    const el = screen.getByRole('combobox', { name: 'Search in' });
    expect(within(el).getAllByRole('option').map((o) => o.textContent)).toEqual(['Library', 'Media server', 'Local files', 'Everything']);
    expect(el).toHaveValue('songs');
  });

  it('shows the count of each scope once there is a search, and "Everything" is the sum', () => {
    select('songs', { songs: 0, media: 2, local: 41 });
    const el = screen.getByRole('combobox', { name: 'Search in' });
    expect(within(el).getAllByRole('option').map((o) => o.textContent)).toEqual(['Library (0)', 'Media server (2)', 'Local files (41)', 'Everything (43)']);
  });

  it('reports the chosen scope', () => {
    const onChange = select('songs', null);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search in' }), { target: { value: 'media' } });
    expect(onChange).toHaveBeenCalledWith('media');
  });

  it('speaks Italian: "Cerca in: Libreria · Media server · File locali · Tutto"', () => {
    setStoredLanguage('it');
    select('songs', null);
    const el = screen.getByRole('combobox', { name: 'Cerca in' });
    expect(within(el).getAllByRole('option').map((o) => o.textContent)).toEqual(['Libreria', 'Media server', 'File locali', 'Tutto']);
  });
});

