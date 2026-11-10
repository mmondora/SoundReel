import type { ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewSwitch } from './ViewSwitch';
import { UiPrefsProvider } from '../../hooks/useUiPrefs';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import * as api from '../../services/api';
import type { UiPrefs } from '../../types';

vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  fetchUiPrefs: vi.fn(),
  saveUiPrefs: vi.fn(),
  resetUiPrefs: vi.fn(),
}));

// Look and feel P3: every page with views has the same switch at the top (Home · Studio · Bacheca; the Link page has no Home). Choosing a view
// draws it at once and saves it for the user, only for that page; a refusal puts the view back and says so.

const t = translations.en;
const SECTIONS: UiPrefs['home']['sections'] = [
  { id: 'resume', visible: true }, { id: 'songs', visible: true }, { id: 'playlists', visible: true },
  { id: 'collections', visible: true }, { id: 'films', visible: true },
];
const BASE: UiPrefs = { v: 1, views: { inbox: 'studio', links: 'studio' }, home: { sections: SECTIONS }, player: { dock: 'bottom', float: { x: 1, y: 1 } } };

const fetchPrefs = vi.mocked(api.fetchUiPrefs);
const savePrefs = vi.mocked(api.saveUiPrefs);

const wrap = ({ children }: { children: ReactNode }) => (
  <LanguageProvider><UiPrefsProvider>{children}</UiPrefsProvider></LanguageProvider>
);

const group = () => screen.findByRole('group', { name: t.viewSwitchLabel });
const labels = async () => within(await group()).getAllByRole('radio').map((r) => (r.closest('label')?.textContent ?? ''));

beforeEach(() => {
  sessionStorage.clear();
  fetchPrefs.mockReset();
  savePrefs.mockReset();
  fetchPrefs.mockResolvedValue(BASE);
});

describe('the switch of the views', () => {
  it('the Inbox offers Home, Studio and Bacheca; the Link page only Studio and Bacheca (it has no Home)', async () => {
    const inbox = render(<ViewSwitch page="inbox" />, { wrapper: wrap });
    expect(await labels()).toEqual([t.viewHome, t.viewStudio, t.viewWall]);
    inbox.unmount();
    render(<ViewSwitch page="links" />, { wrapper: wrap });
    expect(await labels()).toEqual([t.viewStudio, t.viewWall]);
  });

  it('the view the server answered is the checked one', async () => {
    fetchPrefs.mockResolvedValue({ ...BASE, views: { inbox: 'wall', links: 'studio' } });
    render(<ViewSwitch page="inbox" />, { wrapper: wrap });
    await waitFor(() => expect(screen.getByRole('radio', { name: t.viewWall })).toBeChecked());
    expect(screen.getByRole('radio', { name: t.viewStudio })).not.toBeChecked();
  });

  it('choosing a view checks it at once and saves only that page', async () => {
    savePrefs.mockResolvedValue({ ...BASE, views: { inbox: 'home', links: 'studio' } });
    render(<ViewSwitch page="inbox" />, { wrapper: wrap });
    await userEvent.click(await screen.findByRole('radio', { name: t.viewHome }));
    expect(screen.getByRole('radio', { name: t.viewHome })).toBeChecked();
    expect(savePrefs).toHaveBeenCalledWith({ views: { inbox: 'home' } });
  });

  it('shows nothing while the first answer is on its way, so the page does not flash the wrong view', async () => {
    let answer!: (doc: UiPrefs) => void;
    fetchPrefs.mockReturnValue(new Promise<UiPrefs>((resolve) => { answer = resolve; }));
    render(<ViewSwitch page="inbox" />, { wrapper: wrap });
    expect(screen.queryByRole('group', { name: t.viewSwitchLabel })).toBeNull();
    await act(async () => { answer(BASE); });
    expect(await group()).toBeInTheDocument();
  });

  it('a refusal of the server puts the view back and says so; the message can be dismissed', async () => {
    savePrefs.mockRejectedValue(new Error('{"error":"invalid_prefs:views.inbox"}'));
    render(<ViewSwitch page="inbox" />, { wrapper: wrap });
    await userEvent.click(await screen.findByRole('radio', { name: t.viewWall }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t.prefsSaveError);
    expect(screen.getByRole('radio', { name: t.viewStudio })).toBeChecked();
    await userEvent.click(within(alert).getByRole('button', { name: t.dismiss }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('with no user (401) the choice stays for this visit and there is no message', async () => {
    savePrefs.mockRejectedValue(new api.UiPrefsAnonymousError());
    render(<ViewSwitch page="inbox" />, { wrapper: wrap });
    await userEvent.click(await screen.findByRole('radio', { name: t.viewWall }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(screen.getByRole('radio', { name: t.viewWall })).toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
