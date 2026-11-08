import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MusicFoldersSection } from './MusicFoldersSection';
import { FOLDERS_POLL_MAX, FOLDERS_POLL_MS } from '../../hooks/useMusicFolders';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import * as api from '../../services/api';
import type { FolderBrowse, MeResponse, MusicFolder, MusicFolderInput, MusicFoldersPayload } from '../../types';

// "Cartelle musica" in the web configuration (spec 2026-11-07-library-search-music-folders-design.md, L4/L7/L8):
// admin only, the list of extra folders is replaced as a whole, a folder is added by browsing, scans are followed.

vi.mock('../../services/api', () => ({
  fetchMe: vi.fn(),
  getMusicFolders: vi.fn(),
  saveMusicFolders: vi.fn(),
  browseMusicFolders: vi.fn(),
  rescanMusicFolders: vi.fn(),
}));

const ME = (isAdmin: boolean): MeResponse => ({ user: 'mike', displayName: 'Michele', isAdmin, authenticated: true, family: [] });

const folder = (id: string, extra: Partial<MusicFolder> = {}): MusicFolder => ({
  id, path: `/music-extra/${id}`, label: id[0].toUpperCase() + id.slice(1), enabled: true, builtIn: false,
  status: 'ok', files: 12, truncated: false, scannedAt: '2026-11-08T10:00:00Z', ...extra,
});
const LIBRARY: MusicFolder = { id: 'library', path: '/music', label: 'Libreria (Spooty)', enabled: true, builtIn: true, status: 'ok', files: 3400, truncated: false, scannedAt: '2026-11-08T09:30:00Z' };
const ROOTS = [{ path: '/music', label: 'Libreria (Spooty)', builtIn: true }, { path: '/music-extra', label: 'Extra', builtIn: false }];

/** An in-memory stand-in for the backend: it replaces the list on POST, like the real one. */
let extras: MusicFolder[] = [];
const payload = (): MusicFoldersPayload => ({ roots: ROOTS, folders: [LIBRARY, ...extras] });

const TREE: Record<string, FolderBrowse> = {
  '': { path: null, parent: null, dirs: [{ name: 'Extra', path: '/music-extra' }] },
  '/music-extra': { path: '/music-extra', parent: null, dirs: [{ name: 'Rock', path: '/music-extra/Rock' }, { name: 'Jazz', path: '/music-extra/Jazz' }] },
  '/music-extra/Rock': { path: '/music-extra/Rock', parent: '/music-extra', dirs: [{ name: 'Live', path: '/music-extra/Rock/Live' }] },
  '/music-extra/Rock/Live': { path: '/music-extra/Rock/Live', parent: '/music-extra/Rock', dirs: [] },
};

const saved = () => vi.mocked(api.saveMusicFolders).mock.calls.map((c) => c[0]);
const lastSaved = (): MusicFolderInput[] => saved()[saved().length - 1];
const httpError = (code: string, index?: number) => new Error(JSON.stringify(index === undefined ? { error: code } : { error: code, index }));

beforeEach(() => {
  vi.clearAllMocks();
  setStoredLanguage('en');
  extras = [folder('rock'), folder('jazz', { enabled: false, status: 'off', files: 0, scannedAt: null })];
  vi.mocked(api.fetchMe).mockResolvedValue(ME(true));
  vi.mocked(api.getMusicFolders).mockImplementation(async () => payload());
  vi.mocked(api.saveMusicFolders).mockImplementation(async (inputs) => {
    const before = extras;
    extras = inputs.map((i): MusicFolder => {
      const enabled = i.enabled !== false;
      const prev = before.find((f) => f.path === i.path);
      const base = { id: i.path.replace(/\W/g, ''), path: i.path, label: i.label || i.path.split('/').pop() || i.path, enabled, builtIn: false };
      if (!enabled) return { ...base, status: 'off', files: 0, truncated: false, scannedAt: null };
      // like the real server: a folder that was already scanned keeps its scan; a new or re-enabled one waits for one
      if (prev && prev.enabled) return { ...base, status: prev.status, files: prev.files, truncated: prev.truncated, scannedAt: prev.scannedAt };
      return { ...base, status: 'pending', files: 0, truncated: false, scannedAt: null };
    });
    return payload();
  });
  vi.mocked(api.browseMusicFolders).mockImplementation(async (path) => {
    const view = TREE[path ?? ''];
    if (!view) throw httpError('folder_missing');
    return view;
  });
  vi.mocked(api.rescanMusicFolders).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount() {
  return render(
    <LanguageProvider>
      <MusicFoldersSection />
    </LanguageProvider>,
  );
}
const section = async () => {
  const el = await screen.findByTestId('music-folders');
  await within(el).findByRole('list', { name: /^(Music folders|Cartelle musica)$/ }); // the list, not just the heading, is loaded
  return el;
};
const itemOf = (el: HTMLElement, label: string) => {
  const li = within(el).getAllByRole('listitem').find((x) => within(x).queryByText(label) !== null || (within(x).queryByDisplayValue(label) !== null));
  if (!li) throw new Error(`no folder ${label}`);
  return li;
};

describe('admin only (rule L7)', () => {
  it('a plain user sees nothing, and the server is never asked for the folders (it would answer 403)', async () => {
    vi.mocked(api.fetchMe).mockResolvedValue(ME(false));
    const { container } = mount();
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
    expect(api.getMusicFolders).not.toHaveBeenCalled();
  });

  it('an unknown viewer (/api/me failed) counts as a plain user', async () => {
    vi.mocked(api.fetchMe).mockRejectedValue(new Error('offline'));
    const { container } = mount();
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
    expect(api.getMusicFolders).not.toHaveBeenCalled();
  });

  it('an admin gets the section', async () => {
    mount();
    const el = await section();
    expect(within(el).getByRole('heading', { name: 'Music folders' })).toBeInTheDocument();
    expect(api.getMusicFolders).toHaveBeenCalledTimes(1);
  });

  it('is titled "Cartelle musica" in Italian', async () => {
    setStoredLanguage('it');
    mount();
    expect(await screen.findByRole('heading', { name: 'Cartelle musica' })).toBeInTheDocument();
  });
});

describe('the list', () => {
  it('shows the built-in library first and read-only: no label field, no switch, no remove', async () => {
    mount();
    const el = await section();
    const [builtin] = within(el).getAllByRole('listitem');
    expect(builtin).toHaveAttribute('data-folder', 'builtin');
    expect(within(builtin).getByText('Libreria (Spooty)')).toBeInTheDocument();
    expect(within(builtin).getByText('Built-in')).toBeInTheDocument();
    expect(within(builtin).getByText('/music')).toBeInTheDocument();
    expect(within(builtin).getByText('Always included, cannot be changed.')).toBeInTheDocument();
    expect(within(builtin).queryByRole('textbox')).toBeNull();
    expect(within(builtin).queryByRole('switch')).toBeNull();
    expect(within(builtin).queryByRole('button')).toBeNull();
    expect(within(builtin).getByText('3400 files')).toBeInTheDocument();
  });

  it('each extra folder has an editable label, its path, an on/off switch, a status chip and a remove button', async () => {
    mount();
    const el = await section();
    const rock = itemOf(el, 'Rock');
    expect(within(rock).getByRole('textbox', { name: 'Label of folder /music-extra/rock' })).toHaveValue('Rock');
    expect(within(rock).getByText('/music-extra/rock')).toBeInTheDocument();
    expect(within(rock).getByRole('switch', { name: 'Search in Rock' })).toBeChecked();
    expect(within(rock).getByText('ready')).toHaveAttribute('data-status', 'ok');
    expect(within(rock).getByText('12 files')).toBeInTheDocument();
    expect(within(rock).getByText(/^last scan /)).toBeInTheDocument();
    expect(within(rock).getByRole('button', { name: 'Remove folder Rock from the list' })).toBeInTheDocument();
  });

  it('a folder that is off says so and does not claim files or a scan', async () => {
    mount();
    const el = await section();
    const jazz = itemOf(el, 'Jazz');
    expect(within(jazz).getByRole('switch', { name: 'Search in Jazz' })).not.toBeChecked();
    expect(within(jazz).getByText('off')).toHaveAttribute('data-status', 'off');
    expect(within(jazz).queryByText(/files/)).toBeNull();
    expect(within(jazz).queryByText(/last scan|never scanned/)).toBeNull();
  });

  it('every status has its words: ready · scanning · waiting · not found · off, and a truncated scan is flagged', async () => {
    extras = [
      folder('a', { status: 'scanning', files: 0, scannedAt: null }),
      folder('b', { status: 'pending', files: 0, scannedAt: null }),
      folder('c', { status: 'missing', files: 0 }),
      folder('d', { truncated: true, files: 200000 }),
    ];
    mount();
    const el = await section();
    expect(within(itemOf(el, 'A')).getByText('scanning…')).toBeInTheDocument();
    expect(within(itemOf(el, 'A')).getByText('never scanned')).toBeInTheDocument();
    expect(within(itemOf(el, 'B')).getByText('waiting to be scanned')).toBeInTheDocument();
    expect(within(itemOf(el, 'C')).getByText('folder not found')).toBeInTheDocument();
    expect(within(itemOf(el, 'D')).getByText(/over the limit: some files are not indexed/)).toBeInTheDocument();
  });

  it('says there are no extra folders, and shows the allowed places and the mounting note', async () => {
    extras = [];
    mount();
    const el = await section();
    expect(within(el).getByText('No extra folders. Add one to search there too.')).toBeInTheDocument();
    expect(within(el).getByText(/Allowed places/)).toHaveTextContent('/music-extra');
    expect(within(el).getByText(/docker-compose\.yml under MUSIC_EXTRA_ROOTS/)).toBeInTheDocument();
  });

  it('the mounting note and the intro are in Italian too', async () => {
    setStoredLanguage('it');
    mount();
    const el = await section();
    expect(within(el).getByText(/montate in sola lettura in docker-compose\.yml sotto MUSIC_EXTRA_ROOTS/)).toBeInTheDocument();
    expect(within(el).getByText(/sola lettura: il backend non le modifica mai/)).toBeInTheDocument();
  });
});

describe('changing the list sends the WHOLE list of extra folders (never the built-in one)', () => {
  it('a new label is saved on blur', async () => {
    mount();
    const el = await section();
    const input = within(itemOf(el, 'Rock')).getByRole('textbox');
    fireEvent.change(input, { target: { value: '  Rock & Roll  ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.saveMusicFolders).toHaveBeenCalledTimes(1));
    expect(lastSaved()).toEqual([
      { path: '/music-extra/rock', label: 'Rock & Roll', enabled: true },
      { path: '/music-extra/jazz', label: 'Jazz', enabled: false },
    ]);
    expect(await within(el).findByDisplayValue('Rock & Roll')).toBeInTheDocument();
  });

  it('Enter commits the label', async () => {
    mount();
    const el = await section();
    const input = within(itemOf(el, 'Rock')).getByRole('textbox');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'Heavy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.saveMusicFolders).toHaveBeenCalledTimes(1));
    expect(lastSaved()[0].label).toBe('Heavy');
  });

  it('Escape throws the edit away; an unchanged label saves nothing', async () => {
    mount();
    const el = await section();
    const input = within(itemOf(el, 'Rock')).getByRole('textbox');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' }); // blurs the field, which must not save what was thrown away
    expect(input).toHaveValue('Rock');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'Rock' } });
    fireEvent.blur(input);
    await act(async () => { await Promise.resolve(); });
    expect(api.saveMusicFolders).not.toHaveBeenCalled();
  });

  it('the on/off switch saves that folder’s flag and leaves the others alone', async () => {
    mount();
    const el = await section();
    fireEvent.click(within(itemOf(el, 'Rock')).getByRole('switch'));
    await waitFor(() => expect(api.saveMusicFolders).toHaveBeenCalledTimes(1));
    expect(lastSaved()).toEqual([
      { path: '/music-extra/rock', label: 'Rock', enabled: false },
      { path: '/music-extra/jazz', label: 'Jazz', enabled: false },
    ]);
    await waitFor(() => expect(within(itemOf(el, 'Rock')).getByRole('switch')).not.toBeChecked());
  });

  it('turning a folder on', async () => {
    mount();
    const el = await section();
    fireEvent.click(within(itemOf(el, 'Jazz')).getByRole('switch'));
    await waitFor(() => expect(lastSaved()?.[1]).toEqual({ path: '/music-extra/jazz', label: 'Jazz', enabled: true }));
  });

  it('removing a folder sends the list without it (the files are not touched: it only leaves the search)', async () => {
    mount();
    const el = await section();
    fireEvent.click(within(itemOf(el, 'Rock')).getByRole('button', { name: /Remove folder Rock/ }));
    await waitFor(() => expect(api.saveMusicFolders).toHaveBeenCalledTimes(1));
    expect(lastSaved()).toEqual([{ path: '/music-extra/jazz', label: 'Jazz', enabled: false }]);
    await waitFor(() => expect(within(el).queryByDisplayValue('Rock')).toBeNull());
  });

  it('removing the last one sends an empty list', async () => {
    extras = [folder('rock')];
    mount();
    const el = await section();
    fireEvent.click(within(itemOf(el, 'Rock')).getByRole('button', { name: /Remove folder/ }));
    await waitFor(() => expect(lastSaved()).toEqual([]));
  });

  it('controls wait while a change is being saved', async () => {
    let finish: (p: MusicFoldersPayload) => void = () => undefined;
    vi.mocked(api.saveMusicFolders).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mount();
    const el = await section();
    fireEvent.click(within(itemOf(el, 'Rock')).getByRole('switch'));
    expect(await within(el).findByText('Saving…')).toBeInTheDocument();
    expect(within(el).getByRole('button', { name: /Add folder/ })).toBeDisabled();
    expect(within(itemOf(el, 'Jazz')).getByRole('switch')).toBeDisabled();
    await act(async () => { finish(payload()); });
    await waitFor(() => expect(within(el).queryByText('Saving…')).toBeNull());
    expect(within(el).getByRole('button', { name: /Add folder/ })).toBeEnabled();
  });
});

describe('adding a folder with the picker (browse, never type)', () => {
  const open = async (el: HTMLElement) => {
    fireEvent.click(within(el).getByRole('button', { name: /Add folder/ }));
    return screen.findByRole('dialog', { name: 'Choose a folder' });
  };

  it('opens on the allowed places (browse with no path)', async () => {
    mount();
    const dialog = await open(await section());
    expect(api.browseMusicFolders).toHaveBeenCalledWith(null);
    expect(await within(dialog).findByRole('button', { name: 'Open Extra' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('picker-path')).toHaveTextContent('Allowed places');
    expect(within(dialog).queryByRole('button', { name: 'Add this folder' })).toBeNull(); // nothing is "current" yet
  });

  it('walks down into subfolders and back up, one browse call per step', async () => {
    mount();
    const dialog = await open(await section());
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Extra' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Rock' }));
    await waitFor(() => expect(within(dialog).getByTestId('picker-path')).toHaveTextContent('/music-extra/Rock'));
    expect(api.browseMusicFolders).toHaveBeenLastCalledWith('/music-extra/Rock');
    fireEvent.click(within(dialog).getByRole('button', { name: /Up/ }));
    await waitFor(() => expect(within(dialog).getByTestId('picker-path')).toHaveTextContent('/music-extra'));
    expect(api.browseMusicFolders).toHaveBeenLastCalledWith('/music-extra');
    // at an allowed place "up" goes back to the list of places
    fireEvent.click(within(dialog).getByRole('button', { name: /Up/ }));
    await waitFor(() => expect(within(dialog).getByTestId('picker-path')).toHaveTextContent('Allowed places'));
    expect(api.browseMusicFolders).toHaveBeenLastCalledWith(null);
  });

  it('adds a subfolder from the list: POST of the whole list plus the new one (no label: the server names it), then closes', async () => {
    mount();
    const el = await section();
    const dialog = await open(el);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Extra' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Jazz' }));
    await waitFor(() => expect(api.saveMusicFolders).toHaveBeenCalledTimes(1));
    expect(lastSaved()).toEqual([
      { path: '/music-extra/rock', label: 'Rock', enabled: true },
      { path: '/music-extra/jazz', label: 'Jazz', enabled: false },
      { path: '/music-extra/Jazz', enabled: true },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const items = within(el).getAllByRole('listitem');
    expect(within(items[items.length - 1]).getByText('/music-extra/Jazz')).toBeInTheDocument();
    expect(within(items[items.length - 1]).getByText('waiting to be scanned')).toBeInTheDocument();
    expect(within(itemOf(el, 'Rock')).getByText('ready')).toBeInTheDocument(); // the others keep their scan
  });

  it('adds the folder it is standing in with "Add this folder"', async () => {
    mount();
    const el = await section();
    const dialog = await open(el);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Extra' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Rock' }));
    await waitFor(() => expect(within(dialog).getByTestId('picker-path')).toHaveTextContent('/music-extra/Rock'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add this folder' }));
    await waitFor(() => expect(api.saveMusicFolders).toHaveBeenCalledTimes(1));
    expect(lastSaved().map((f) => f.path)).toEqual(['/music-extra/rock', '/music-extra/jazz', '/music-extra/Rock']);
  });

  it('a folder that is already in the list cannot be added twice', async () => {
    extras = [folder('Rock', { path: '/music-extra/Rock' })];
    mount();
    const dialog = await open(await section());
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Extra' }));
    expect(await within(dialog).findByRole('button', { name: 'Add Rock' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Add Jazz' })).toBeEnabled();
  });

  it('with no extra place mounted it says how to get one (MUSIC_EXTRA_ROOTS), and offers nothing to add', async () => {
    vi.mocked(api.browseMusicFolders).mockResolvedValue({ path: null, parent: null, dirs: [] });
    mount();
    const dialog = await open(await section());
    expect(await within(dialog).findByText(/Mount one in docker-compose\.yml under MUSIC_EXTRA_ROOTS/)).toBeInTheDocument();
  });

  it('an empty folder says so', async () => {
    mount();
    const dialog = await open(await section());
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Extra' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Rock' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Live' }));
    expect(await within(dialog).findByText('No subfolders.')).toBeInTheDocument();
  });

  it('a refused folder is explained INSIDE the dialog, which stays open', async () => {
    vi.mocked(api.saveMusicFolders).mockRejectedValueOnce(httpError('folder_not_directory', 2));
    mount();
    const dialog = await open(await section());
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open Extra' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Jazz' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('“/music-extra/Jazz”: The path is not a folder.');
    expect(screen.getByRole('dialog', { name: 'Choose a folder' })).toBeInTheDocument();
  });

  it('a browse failure is said in the dialog', async () => {
    vi.mocked(api.browseMusicFolders).mockRejectedValueOnce(httpError('folder_outside_roots'));
    mount();
    const dialog = await open(await section());
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('outside the allowed places');
  });

  it('closing it adds nothing', async () => {
    mount();
    const el = await section();
    const dialog = await open(el);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.saveMusicFolders).not.toHaveBeenCalled();
  });
});

describe('every error the server can answer, in Italian', () => {
  beforeEach(() => setStoredLanguage('it'));

  it.each([
    ['folder_outside_roots', 1, '«/music-extra/jazz»: La cartella è fuori dalle posizioni consentite (solo quelle montate nel container).'],
    ['folder_missing', 0, '«/music-extra/rock»: La cartella non esiste (o non è montata nel container).'],
    ['folder_not_directory', 0, '«/music-extra/rock»: Il percorso non è una cartella.'],
    ['already_included', 1, '«/music-extra/jazz»: Questa cartella fa già parte della libreria di Spooty: si cerca per intero.'],
    ['invalid_folder', 0, '«/music-extra/rock»: Percorso non valido: serve un percorso assoluto.'],
    ['too_many_folders', -1, 'Troppe cartelle: il massimo è 20.'],
    ['forbidden', undefined, 'Solo l’admin può cambiare le cartelle musica.'],
  ] as const)('%s → a clear Italian message that names the folder at fault', async (code, index, text) => {
    vi.mocked(api.saveMusicFolders).mockRejectedValueOnce(httpError(code, index));
    mount();
    const el = await section();
    fireEvent.click(within(el).getAllByRole('switch')[0]);
    expect(await within(el).findByRole('alert')).toHaveTextContent(text);
  });

  it('an error the page has no words for shows what the server said', async () => {
    vi.mocked(api.saveMusicFolders).mockRejectedValueOnce(httpError('disk_on_fire'));
    mount();
    const el = await section();
    fireEvent.click(within(el).getAllByRole('switch')[0]);
    expect(await within(el).findByRole('alert')).toHaveTextContent('Operazione non riuscita: disk_on_fire');
  });

  it('the server being unreachable', async () => {
    vi.mocked(api.saveMusicFolders).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    const el = await section();
    fireEvent.click(within(el).getAllByRole('switch')[0]);
    expect(await within(el).findByRole('alert')).toHaveTextContent('Server non raggiungibile.');
  });

  it('a refused change leaves the list as it was, and the folder at fault is marked', async () => {
    vi.mocked(api.saveMusicFolders).mockRejectedValueOnce(httpError('folder_missing', 0));
    mount();
    const el = await section();
    fireEvent.click(within(el).getAllByRole('switch')[0]);
    await within(el).findByRole('alert');
    expect(within(el).getAllByRole('switch')[0]).toBeChecked();
    expect(within(el).getAllByRole('listitem').find((li) => li.className.includes('is-bad'))).toHaveTextContent('/music-extra/rock');
  });

  it('403 on the list itself (the admin check and the server disagree) is explained with a retry', async () => {
    vi.mocked(api.getMusicFolders).mockRejectedValueOnce(httpError('forbidden'));
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cartelle musica non disponibili');
    expect(alert).toHaveTextContent('Solo l’admin può cambiare le cartelle musica.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByTestId('music-folders')).toBeInTheDocument();
    expect(api.getMusicFolders).toHaveBeenCalledTimes(2);
  });

  it('the error goes away with the next successful change', async () => {
    vi.mocked(api.saveMusicFolders).mockRejectedValueOnce(httpError('folder_missing', 0));
    mount();
    const el = await section();
    fireEvent.click(within(el).getAllByRole('switch')[0]);
    await within(el).findByRole('alert');
    fireEvent.click(within(el).getAllByRole('switch')[0]);
    await waitFor(() => expect(within(el).queryByRole('alert')).toBeNull());
  });
});

describe('following a scan', () => {
  it('asks again every 3 s while a folder is scanning or waiting, then stops when everything is settled', async () => {
    vi.useFakeTimers();
    extras = [folder('rock', { status: 'scanning', files: 0, scannedAt: null })];
    let calls = 0;
    vi.mocked(api.getMusicFolders).mockImplementation(async () => {
      calls += 1;
      if (calls >= 3) extras = [folder('rock', { status: 'ok', files: 77 })];
      return payload();
    });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toBe(1);
    expect(FOLDERS_POLL_MS).toBe(3000);
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls).toBe(2);
    expect(screen.getByText('scanning…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(calls).toBe(3);
    expect(within(screen.getByTestId('music-folders')).getAllByText('ready')).toHaveLength(2); // the library and the folder
    expect(screen.getByText('77 files')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls).toBe(3); // settled: no more asking
  });

  it('a folder that was just added (waiting) is followed too', async () => {
    vi.useFakeTimers();
    extras = [folder('rock', { status: 'pending', files: 0, scannedAt: null })];
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.getMusicFolders).toHaveBeenCalledTimes(2);
  });

  it('nothing is asked again when no folder is scanning (off and missing folders are settled)', async () => {
    vi.useFakeTimers();
    extras = [folder('rock', { status: 'missing' }), folder('jazz', { enabled: false, status: 'pending' })];
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.getMusicFolders).toHaveBeenCalledTimes(1);
  });

  it('a failed poll does not break the page: it keeps what it shows and tries again', async () => {
    vi.useFakeTimers();
    extras = [folder('rock', { status: 'scanning', files: 0, scannedAt: null })];
    vi.mocked(api.getMusicFolders)
      .mockImplementationOnce(async () => payload())
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockImplementation(async () => { extras = [folder('rock', { files: 77 })]; return payload(); });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('scanning…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('77 files')).toBeInTheDocument();
  });

  it('gives up after a while: a server stuck on "waiting" is not asked forever', async () => {
    vi.useFakeTimers();
    extras = [folder('rock', { status: 'pending', files: 0, scannedAt: null })];
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // one poll at a time: React has to render and schedule the next one in between
    for (let i = 0; i < FOLDERS_POLL_MAX + 30; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(FOLDERS_POLL_MS); });
    }
    expect(vi.mocked(api.getMusicFolders).mock.calls.length).toBe(FOLDERS_POLL_MAX + 1);
  });

  it('"Rescan now" asks the server for a scan and reloads the list', async () => {
    mount();
    const el = await section();
    extras = [folder('rock', { status: 'scanning', files: 0, scannedAt: null }), folder('jazz', { enabled: false, status: 'off', files: 0, scannedAt: null })];
    fireEvent.click(within(el).getByRole('button', { name: /Rescan now/ }));
    await waitFor(() => expect(api.rescanMusicFolders).toHaveBeenCalledTimes(1));
    expect(await within(el).findByText('scanning…')).toBeInTheDocument();
  });

  it('a refused rescan is explained', async () => {
    vi.mocked(api.rescanMusicFolders).mockRejectedValueOnce(httpError('forbidden'));
    mount();
    const el = await section();
    fireEvent.click(within(el).getByRole('button', { name: /Rescan now/ }));
    expect(await within(el).findByRole('alert')).toHaveTextContent('Only the admin can change the music folders.');
  });
});
