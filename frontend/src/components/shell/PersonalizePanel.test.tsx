import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PersonalizePanel } from './PersonalizePanel';
import { UiPrefsProvider } from '../../hooks/useUiPrefs';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import * as api from '../../services/api';
import { applyPrefsPatch } from '../../utils/uiPrefs';
import type { HomeSectionId, PlayerDock, UiPrefs } from '../../types';

// Look and feel P4 (spec 2026-11-10-web-look-and-feel-rethink-design.md L1, L3, L4): the panel where the user chooses where the Player is, which
// sections the Home has and in what order, sees what view every page remembers, and sees that the colours are fixed. Every control writes its
// part of the configuration on the server, and what the user sees changes at once.

vi.mock('../../services/api', () => ({
  fetchUiPrefs: vi.fn(),
  saveUiPrefs: vi.fn(),
  resetUiPrefs: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

const t = translations.en;
const sections = (...entries: Array<[HomeSectionId, boolean]>) => entries.map(([id, visible]) => ({ id, visible }));
const FULL = sections(['resume', true], ['songs', true], ['playlists', true], ['collections', true], ['films', true]);
const prefs = (over: Partial<{ dock: PlayerDock; sections: UiPrefs['home']['sections']; inbox: UiPrefs['views']['inbox']; links: UiPrefs['views']['links'] }> = {}): UiPrefs => ({
  v: 1,
  views: { inbox: over.inbox ?? 'studio', links: over.links ?? 'studio' },
  home: { sections: over.sections ?? FULL },
  player: { dock: over.dock ?? 'bottom', float: { x: 1, y: 1 } },
});

const fetchPrefs = vi.mocked(api.fetchUiPrefs);
const savePrefs = vi.mocked(api.saveUiPrefs);
const resetPrefs = vi.mocked(api.resetUiPrefs);

function renderPanel(onClose: () => void = () => undefined) {
  return render(<LanguageProvider><UiPrefsProvider><PersonalizePanel onClose={onClose} /></UiPrefsProvider></LanguageProvider>);
}

/** The panel with the configuration already read. */
async function openPanel(onClose: () => void = () => undefined) {
  const view = renderPanel(onClose);
  await screen.findByRole('radio', { name: t.playerDockBottom });
  return view;
}

const switches = () => screen.getAllByRole('switch').map((s) => `${s.closest('label')?.textContent}:${(s as HTMLInputElement).checked}`);

/** A server that keeps one document and merges what it is sent, like the real one (docs/ui-prefs.md). */
function fakeServer(start: UiPrefs): void {
  let doc = start;
  fetchPrefs.mockImplementation(async () => doc);
  savePrefs.mockImplementation(async (patch) => { doc = applyPrefsPatch(doc, patch); return doc; });
  resetPrefs.mockImplementation(async () => { doc = prefs(); return doc; });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  fakeServer(prefs());
});

describe('the panel', () => {
  it('is a modal dialog with its title, and the focus goes into it', async () => {
    await openPanel();
    const dialog = screen.getByRole('dialog', { name: t.personalizeTitle });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Escape closes it, and so do the × and a click on the dark around it', async () => {
    const onClose = vi.fn();
    const { container } = await openPanel(onClose);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: t.dismiss }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(container.querySelector('.personalize-scrim') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('a click inside the panel does not close it', async () => {
    const onClose = vi.fn();
    await openPanel(onClose);
    await userEvent.click(screen.getByRole('heading', { name: t.personalizeTitle }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('waits for the first answer, and says so when there is none (no controls that would write nothing)', async () => {
    fetchPrefs.mockRejectedValue(new Error('network down'));
    renderPanel();
    expect(await screen.findByText(t.personalizeUnavailable)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('the Player', () => {
  it('has four places, the saved one is checked', async () => {
    fakeServer(prefs({ dock: 'side' }));
    renderPanel();
    await screen.findByRole('radio', { name: t.playerDockSide });
    const group = screen.getByRole('group', { name: t.personalizePlayerWhere });
    expect(within(group).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([t.playerDockBottom, t.playerDockFloat, t.playerDockSide, t.playerDockHidden]);
    expect(screen.getByRole('radio', { name: t.playerDockSide })).toBeChecked();
    expect(screen.getByRole('radio', { name: t.playerDockBottom })).not.toBeChecked();
  });

  it.each([
    ['float', 'playerDockFloat'],
    ['side', 'playerDockSide'],
    ['hidden', 'playerDockHidden'],
  ] as const)('choosing %s writes only the dock and shows it at once', async (dock, key) => {
    await openPanel();
    await userEvent.click(screen.getByRole('radio', { name: t[key] }));
    expect(screen.getByRole('radio', { name: t[key] })).toBeChecked();
    expect(savePrefs).toHaveBeenCalledWith({ player: { dock } });
  });

  it('choosing the bottom again after another place writes the bottom', async () => {
    fakeServer(prefs({ dock: 'hidden' }));
    renderPanel();
    await userEvent.click(await screen.findByRole('radio', { name: t.playerDockBottom }));
    expect(savePrefs).toHaveBeenCalledWith({ player: { dock: 'bottom' } });
  });
});

describe('the sections of the Home', () => {
  it('lists the five sections in the configured order, each with its switch', async () => {
    fakeServer(prefs({ sections: sections(['films', true], ['resume', false], ['songs', true], ['collections', true], ['playlists', false]) }));
    renderPanel();
    await screen.findByRole('switch', { name: t.homeSectionFilms });
    expect(switches()).toEqual([`${t.homeSectionFilms}:true`, `${t.homeSectionResume}:false`, `${t.homeSectionSongs}:true`, `${t.homeSectionCollections}:true`, `${t.homeSectionPlaylists}:false`]);
  });

  it('a switch writes the WHOLE list (order and switches), with that section toggled, and shows it at once', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('switch', { name: t.homeSectionSongs }));
    expect(screen.getByRole('switch', { name: t.homeSectionSongs })).not.toBeChecked();
    expect(savePrefs).toHaveBeenCalledWith({ home: { sections: sections(['resume', true], ['songs', false], ['playlists', true], ['collections', true], ['films', true]) } });
  });

  it('the arrows move a section one place and write the whole list', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: t.personalizeMoveUp.replace('{name}', t.homeSectionPlaylists) }));
    expect(switches().map((s) => s.split(':')[0])).toEqual([t.homeSectionResume, t.homeSectionPlaylists, t.homeSectionSongs, t.homeSectionCollections, t.homeSectionFilms]);
    expect(savePrefs).toHaveBeenLastCalledWith({ home: { sections: sections(['resume', true], ['playlists', true], ['songs', true], ['collections', true], ['films', true]) } });
    await userEvent.click(screen.getByRole('button', { name: t.personalizeMoveDown.replace('{name}', t.homeSectionResume) }));
    expect(savePrefs).toHaveBeenLastCalledWith({ home: { sections: sections(['playlists', true], ['resume', true], ['songs', true], ['collections', true], ['films', true]) } });
  });

  it('the first section cannot go up and the last cannot go down', async () => {
    await openPanel();
    expect(screen.getByRole('button', { name: t.personalizeMoveUp.replace('{name}', t.homeSectionResume) })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.personalizeMoveDown.replace('{name}', t.homeSectionFilms) })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.personalizeMoveUp.replace('{name}', t.homeSectionSongs) })).toBeEnabled();
    expect(screen.getByRole('button', { name: t.personalizeMoveDown.replace('{name}', t.homeSectionResume) })).toBeEnabled();
  });

  it('the collections are listed and marked as coming (they are not built yet)', async () => {
    await openPanel();
    const row = screen.getByRole('switch', { name: t.homeSectionCollections }).closest('li') as HTMLElement;
    expect(row).toHaveTextContent(t.personalizeSoon);
    expect(screen.getByRole('switch', { name: t.homeSectionSongs }).closest('li')).not.toHaveTextContent(t.personalizeSoon);
  });
});

describe('the views, the colours, the reset', () => {
  it('shows the view every page remembers (read only: it is changed from the page)', async () => {
    fakeServer(prefs({ inbox: 'home', links: 'wall' }));
    renderPanel();
    await screen.findByRole('radio', { name: t.playerDockBottom });
    const list = screen.getByRole('list', { name: t.personalizeViews });
    expect(within(list).getByText(t.navInbox).closest('li')).toHaveTextContent(t.viewHome);
    expect(within(list).getByText(t.personalizePageLinks).closest('li')).toHaveTextContent(t.viewWall);
    expect(screen.getByText(t.personalizeViewsHint)).toBeInTheDocument();
    expect(within(list).queryByRole('radio')).toBeNull();
  });

  it('says that the colours are fixed, with a lock, and offers nothing to change them', async () => {
    await openPanel();
    const colours = screen.getByRole('heading', { name: t.personalizeColours }).closest('section') as HTMLElement;
    expect(colours).toHaveTextContent(t.personalizeColoursLocked);
    expect(within(colours).queryByRole('button')).toBeNull();
    expect(within(colours).queryByRole('radio')).toBeNull();
  });

  it('«back to the starting values» asks first; yes erases the choices on the server, no leaves them', async () => {
    fakeServer(prefs({ dock: 'float', inbox: 'wall' }));
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: t.personalizeReset }));
    expect(screen.getByText(t.personalizeResetAsk)).toBeInTheDocument();
    expect(resetPrefs).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.personalizeResetNo }));
    expect(screen.queryByText(t.personalizeResetAsk)).toBeNull();
    expect(resetPrefs).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.personalizeReset }));
    await userEvent.click(screen.getByRole('button', { name: t.personalizeResetYes }));
    expect(resetPrefs).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('radio', { name: t.playerDockBottom })).toBeChecked());
    expect(screen.queryByText(t.personalizeResetAsk)).toBeNull();
  });

  it('a change the server refuses goes back, and a message says so (it can be dismissed)', async () => {
    savePrefs.mockRejectedValue(new Error('{"error":"invalid_prefs:player.dock"}'));
    await openPanel();
    await userEvent.click(screen.getByRole('radio', { name: t.playerDockSide }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.prefsSaveError);
    expect(screen.getByRole('radio', { name: t.playerDockBottom })).toBeChecked();
    await userEvent.click(within(alert).getByRole('button', { name: t.dismiss }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
