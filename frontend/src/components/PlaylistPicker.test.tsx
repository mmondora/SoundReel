import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PlaylistPicker } from './PlaylistPicker';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import * as api from '../services/api';
import type { PlaylistPage, PlaylistSummary } from '../types';

// The choice of a playlist (Michele, 10 November: «la scelta della playlist non può essere un box - quando sono 100 che facciamo ?»): not a drop-down
// with all of them inside, but a button that opens a dialog with search, «show», sort and pages of 30, asked to the SERVER (ADR-0023, rule P).

vi.mock('../services/api', () => ({ fetchPlaylistsPage: vi.fn() }));

const t = translations.en;
const ask = vi.mocked(api.fetchPlaylistsPage);

const pl = (n: number, over: Partial<PlaylistSummary> = {}): PlaylistSummary => ({
  id: `p${n}`, name: `Playlist ${n}`, songCount: n, createdAt: '2026-11-0' + ((n % 9) + 1) + 'T10:00:00.000Z', updatedAt: '2026-11-09T10:00:00.000Z', ...over,
});
const page = (from: number, count: number, total: number, offset = 0): PlaylistPage => ({ playlists: Array.from({ length: count }, (_, i) => pl(from + i)), total, limit: 30, offset });

interface Harness { onChange: ReturnType<typeof vi.fn> }

function Host({ onChange, initial = null, ownerLabel }: { onChange: (id: string | null) => void; initial?: string | null; ownerLabel?: (p: PlaylistSummary) => string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <PlaylistPicker
      value={value}
      onChange={(id) => { setValue(id); onChange(id); }}
      allLabel="All songs (45)"
      valueLabel={value ? `Playlist ${value.slice(1)} (${value.slice(1)})` : 'All songs (45)'}
      ariaLabel="Content of the pane (A)"
      ownerLabel={ownerLabel}
    />
  );
}

function renderPicker(props: Partial<Parameters<typeof Host>[0]> = {}): Harness {
  const onChange = vi.fn();
  render(<LanguageProvider><Host onChange={onChange} {...props} /></LanguageProvider>);
  return { onChange };
}

const opener = () => screen.getByRole('button', { name: /Content of the pane \(A\)/ });
const dialog = () => screen.getByRole('dialog', { name: t.playlistPickerTitle });
const rows = () => within(dialog()).getAllByRole('button').filter((b) => b.hasAttribute('data-pl-option'));

beforeEach(() => {
  vi.clearAllMocks();
  ask.mockResolvedValue(page(1, 30, 120));
});

describe('the choice of a playlist — what a screen reader hears', () => {
  it('the button is named after the place and what is in it', () => {
    renderPicker({ initial: 'p7' });
    expect(opener()).toHaveAccessibleName('Content of the pane (A): Playlist 7 (7)');
  });

  it('the dialog is a child of the page body, not of the place where the button is (a sheet or a pane that clips it cannot)', async () => {
    renderPicker();
    await userEvent.click(opener());
    expect(dialog().closest('.pl-pick-root')?.parentElement).toBe(document.body);
  });
});

describe('the choice of a playlist — closed', () => {
  it('is a button that says what is chosen; nothing is asked and nothing is listed until it is opened', () => {
    renderPicker();
    expect(opener()).toHaveTextContent('All songs (45)');
    expect(opener()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(opener()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('says the chosen playlist, as the page words it', () => {
    renderPicker({ initial: 'p7' });
    expect(opener()).toHaveTextContent('Playlist 7 (7)');
  });
});

describe('the choice of a playlist — the dialog', () => {
  it('opens with the search, «show», the sort and the first page; «All songs» is always there', async () => {
    renderPicker();
    await userEvent.click(opener());
    expect(opener()).toHaveAttribute('aria-expanded', 'true');
    const d = dialog();
    expect(within(d).getByRole('button', { name: 'All songs (45)' })).toBeInTheDocument();
    expect(within(d).getByRole('searchbox', { name: t.playlistSearchPlaceholder })).toHaveFocus();
    expect(within(d).getByRole('group', { name: t.playlistFilterLabel })).toBeInTheDocument();
    expect(within(d).getByRole('combobox', { name: t.playlistSortLabel })).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(30));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ filter: 'all', sort: 'created', order: 'desc', limit: 30, offset: 0 }));
  });

  it('draws one page of rows however many playlists there are (120 here), and says which page it is', async () => {
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    expect(within(dialog()).getByText(t.pageOf.replace('{page}', '1').replace('{total}', '4'))).toBeInTheDocument();
    expect(within(dialog()).getByText(t.playlistPickerTotal.replace('{count}', '120'))).toBeVisible();
  });

  it('the next page replaces the rows, and the previous goes back', async () => {
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    ask.mockResolvedValueOnce(page(31, 30, 120, 30));
    await userEvent.click(within(dialog()).getByRole('button', { name: t.nextPage }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: /Playlist 31\b/ })).toBeInTheDocument());
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30, limit: 30 }));
    expect(within(dialog()).queryByRole('button', { name: /Playlist 1\b/ })).toBeNull();
    ask.mockResolvedValueOnce(page(1, 30, 120));
    await userEvent.click(within(dialog()).getByRole('button', { name: t.previousPage }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: /Playlist 1\b/ })).toBeInTheDocument());
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('has no pager when everything fits in one page', async () => {
    ask.mockResolvedValue(page(1, 12, 12));
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(12));
    expect(within(dialog()).queryByRole('button', { name: t.nextPage })).toBeNull();
  });

  it('a row says how many songs it has and when it was made; a dynamic one has its glyph', async () => {
    ask.mockResolvedValue({ playlists: [pl(3, { createdAt: '2026-10-01T10:00:00.000Z', kind: 'dynamic' }), pl(1, { songCount: 1 })], total: 2, limit: 30, offset: 0 });
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent('◷');
    expect(rows()[0]).toHaveTextContent('Playlist 3');
    expect(rows()[0]).toHaveTextContent(t.mgrItems.replace('{n}', '3'));
    expect(rows()[0]).toHaveTextContent('Oct 1');
    expect(rows()[1]).toHaveTextContent(t.mgrItemOne);
  });

  it('a shared playlist says whose it is (the page knows the names)', async () => {
    ask.mockResolvedValue({ playlists: [pl(2, { ownerUser: 'sara' })], total: 1, limit: 30, offset: 0 });
    renderPicker({ ownerLabel: (p) => (p.ownerUser === 'sara' ? 'of Sara' : null) });
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent('of Sara');
  });
});

describe('the choice of a playlist — choosing', () => {
  it('a row reports its playlist, closes the dialog and gives the focus back to the button', async () => {
    const { onChange } = renderPicker();
    await userEvent.click(opener());
    await userEvent.click(await within(dialog()).findByRole('button', { name: /Playlist 5\b/ }));
    expect(onChange).toHaveBeenCalledWith('p5');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener()).toHaveFocus();
    expect(opener()).toHaveTextContent('Playlist 5 (5)');
  });

  it('the focus goes back to the button even when the click that opened the dialog did not focus it (Safari does not focus a button on click)', async () => {
    renderPicker();
    fireEvent.click(opener());
    expect(opener()).not.toHaveFocus();
    await userEvent.click(await within(dialog()).findByRole('button', { name: /Playlist 5\b/ }));
    expect(opener()).toHaveFocus();
  });

  it('«All songs» reports no playlist', async () => {
    const { onChange } = renderPicker({ initial: 'p7' });
    await userEvent.click(opener());
    await userEvent.click(within(dialog()).getByRole('button', { name: 'All songs (45)' }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks the one that is chosen', async () => {
    renderPicker({ initial: 'p3' });
    await userEvent.click(opener());
    const chosen = await within(dialog()).findByRole('button', { name: /Playlist 3\b/ });
    expect(chosen).toHaveAttribute('aria-current', 'true');
    expect(within(dialog()).getByRole('button', { name: /Playlist 4\b/ })).not.toHaveAttribute('aria-current');
    expect(within(dialog()).getByRole('button', { name: 'All songs (45)' })).not.toHaveAttribute('aria-current');
  });

  it('marks «All songs» when no playlist is chosen', async () => {
    renderPicker();
    await userEvent.click(opener());
    expect(within(dialog()).getByRole('button', { name: 'All songs (45)' })).toHaveAttribute('aria-current', 'true');
  });
});

describe('the choice of a playlist — search, show, sort (the server does them)', () => {
  it('what is typed goes to the server after a pause, and the page goes back to the first', async () => {
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    ask.mockResolvedValueOnce(page(31, 30, 120, 30));
    await userEvent.click(within(dialog()).getByRole('button', { name: t.nextPage }));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30 })));
    ask.mockResolvedValue({ playlists: [pl(40, { name: 'Jazz da ascoltare' })], total: 1, limit: 30, offset: 0 });
    await userEvent.type(within(dialog()).getByRole('searchbox', { name: t.playlistSearchPlaceholder }), 'jazz');
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'jazz', offset: 0 })));
    expect(await within(dialog()).findByRole('button', { name: /Jazz da ascoltare/ })).toBeInTheDocument();
  });

  it('«show» and the sort are asked too', async () => {
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    await userEvent.click(within(dialog()).getByRole('button', { name: t.playlistFilterAuto }));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'auto', offset: 0 })));
    await userEvent.selectOptions(within(dialog()).getByRole('combobox', { name: t.playlistSortLabel }), 'name');
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'name', order: 'asc' })));
  });

  it('says so when nothing matches the search, and when there is no playlist at all', async () => {
    ask.mockResolvedValueOnce({ playlists: [], total: 0, limit: 30, offset: 0 });
    renderPicker();
    await userEvent.click(opener());
    expect(await within(dialog()).findByText(t.playlistEmpty)).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
    ask.mockResolvedValue({ playlists: [], total: 0, limit: 30, offset: 0 });
    await userEvent.type(within(dialog()).getByRole('searchbox', { name: t.playlistSearchPlaceholder }), 'zzz');
    expect(await within(dialog()).findByText(t.playlistNoMatch)).toBeInTheDocument();
  });

  it('a failure says so, and «Retry» asks again', async () => {
    ask.mockRejectedValueOnce(new Error('down'));
    renderPicker();
    await userEvent.click(opener());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(t.playlistPickerFailed);
    await userEvent.click(within(dialog()).getByRole('button', { name: t.libRetry }));
    await waitFor(() => expect(rows()).toHaveLength(30));
  });
});

describe('the choice of a playlist — the keyboard', () => {
  it('the arrows go from the search to the rows and between them, Up from the first row comes back to the search, Enter chooses', async () => {
    const { onChange } = renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    const search = within(dialog()).getByRole('searchbox', { name: t.playlistSearchPlaceholder });
    expect(search).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(rows()[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(rows()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(rows()[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('p2');
  });

  it('Down on the last row stays on the last row; the arrows keep the page from scrolling, the other keys are left alone', async () => {
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    await userEvent.keyboard('{ArrowDown}{End}{ArrowDown}');
    expect(rows()[29]).toHaveFocus();
    expect(fireEvent.keyDown(rows()[29], { key: 'ArrowDown' })).toBe(false);   // false = preventDefault() was called
    expect(fireEvent.keyDown(rows()[29], { key: 'Home' })).toBe(false);
    expect(fireEvent.keyDown(rows()[29], { key: 'x' })).toBe(true);
  });

  it('End and Home go to the last and the first row', async () => {
    renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    await userEvent.keyboard('{ArrowDown}{End}');
    expect(rows()[29]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(rows()[0]).toHaveFocus();
  });

  it('Escape closes without choosing, and the focus goes back to the button', async () => {
    const { onChange } = renderPicker();
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(opener()).toHaveFocus();
  });

  it('the dialog is modal: the page behind it is not part of the conversation', async () => {
    renderPicker();
    await userEvent.click(opener());
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
  });

  it('what is typed in the dialog does not reach the components around the button (a sheet that traps Tab, a page with shortcuts)', async () => {
    const around = vi.fn();
    render(
      <LanguageProvider>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div onKeyDown={around}><Host onChange={vi.fn()} /></div>
      </LanguageProvider>,
    );
    await userEvent.click(opener());
    await waitFor(() => expect(rows()).toHaveLength(30));
    await userEvent.keyboard('jazz{ArrowDown}{ArrowUp}{Tab}{Home}');
    expect(around).not.toHaveBeenCalled();
  });
});
