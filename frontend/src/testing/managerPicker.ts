import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import * as api from '../services/api';
import { translations } from '../i18n/translations';
import type { PlaylistSummary } from '../types';

// For the tests of the pages that hold the choice of a playlist (the manager: two panes; the web player). The choice is not a drop-down any more
// but a button that opens a dialog with search and pages (spec 2026-11-10-web-look-and-feel-rethink-design.md §3.6): these helpers open it and pick.

const t = translations.en;

/** The button that says what a pane holds. */
export const locationButton = (pane: 'A' | 'B'): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`Pane content \\(Pane ${pane}\\)`) });

/** `GET /api/playlists?q&limit&offset` served from the playlists the test already has (search by name; the rest of the query is not needed here). */
export function servePlaylistPages(playlists: () => PlaylistSummary[]): void {
  vi.mocked(api.fetchPlaylistsPage).mockImplementation(async (query = {}) => {
    const needle = (query.q ?? '').toLowerCase();
    const all = playlists().filter((p) => !needle || p.name.toLowerCase().includes(needle));
    const limit = query.limit ?? 30;
    const offset = query.offset ?? 0;
    return { playlists: all.slice(offset, offset + limit), total: all.length, limit, offset };
  });
}

/** Opens the dialog of a pane, and picks «All songs» (`'library'`) or the playlist with this name. */
export async function chooseLocation(pane: 'A' | 'B', what: 'library' | string): Promise<void> {
  await userEvent.click(locationButton(pane));
  const dialog = await screen.findByRole('dialog', { name: t.playlistPickerTitle });
  if (what === 'library') {
    await userEvent.click(within(dialog).getByRole('button', { name: /^All songs/ }));
  } else {
    // the name of a row is «name, number of songs…»: the count tells «Mine» from «Mine too»
    await userEvent.click(await within(dialog).findByRole('button', { name: new RegExp(`^(◷ )?${what} (\\d+ songs|1 song)`) }));
  }
}

/** The dialog of the choice, when it is open. */
export const pickerDialog = (): HTMLElement => screen.getByRole('dialog', { name: t.playlistPickerTitle });

/** The button of the panel «Scegli cosa suonare» that says which playlist it plays from (the web player). */
export const playlistButton = (within_: HTMLElement): HTMLElement => within(within_).getByRole('button', { name: /^Playlist: / });

/** In the panel «Scegli cosa suonare»: opens the dialog and picks «All songs» (`'library'`) or the playlist with this name. */
export async function choosePlaylist(panel: HTMLElement, what: 'library' | string): Promise<void> {
  await userEvent.click(playlistButton(panel));
  const dialog = await screen.findByRole('dialog', { name: t.playlistPickerTitle });
  if (what === 'library') {
    await userEvent.click(within(dialog).getByRole('button', { name: /^All songs/ }));
  } else {
    await userEvent.click(await within(dialog).findByRole('button', { name: new RegExp(`^(◷ )?${what} (\\d+ songs|1 song)`) }));
  }
}
