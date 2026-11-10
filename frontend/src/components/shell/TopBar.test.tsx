import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TopBar } from './TopBar';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({ fetchMe: vi.fn() }));

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search + l.hash}</p>;
}

function renderBar(path = '/songs') {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <TopBar />
        <Where />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setStoredLanguage('it');
  vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Michele', isAdmin: true, authenticated: true, family: [] });
});

describe('TopBar', () => {
  it('has the brand, with the version, as a link home', () => {
    renderBar();
    const brand = screen.getByRole('link', { name: /SoundReel/ });
    expect(brand).toHaveAttribute('href', '/');
    expect(brand).toHaveTextContent(/vtest/);
  });

  it('the search writes the text in the address (?q=) and the clear button takes it away', () => {
    renderBar('/songs');
    const box = screen.getByRole('searchbox', { name: 'Cerca nella libreria…' });
    expect(screen.queryByRole('button', { name: 'Cancella la ricerca' })).not.toBeInTheDocument(); // nothing to clear yet
    fireEvent.change(box, { target: { value: 'nightcall' } });
    expect(screen.getByTestId('where')).toHaveTextContent('/songs?q=nightcall');
    fireEvent.click(screen.getByRole('button', { name: 'Cancella la ricerca' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/songs');
    expect(screen.getByTestId('where').textContent).not.toContain('q=');
  });

  it('opens on the text that is already in the address', () => {
    renderBar('/entries?q=vino');
    expect(screen.getByRole('searchbox')).toHaveValue('vino');
  });

  it('the «Incolla un link» button goes to the Inbox, where the paste field takes the focus', () => {
    renderBar('/songs');
    const cta = screen.getByRole('link', { name: 'Incolla un link' });
    expect(cta).toHaveAttribute('href', '/#paste');
  });

  it('shows who is signed in (and «admin»), from the server', async () => {
    renderBar();
    expect(await screen.findByText(/Michele · admin/)).toBeInTheDocument();
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('keeps working when the server does not say who is signed in', async () => {
    vi.mocked(api.fetchMe).mockRejectedValue(new Error('offline'));
    renderBar();
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: /SoundReel/ })).toBeInTheDocument();
    expect(screen.queryByText(/admin/)).not.toBeInTheDocument();
  });

  it('the menu has Libreria, Console, Prompt, Admin and Impostazioni, opens on click and closes on a click outside', () => {
    renderBar();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Altro' }));
    const items = screen.getAllByRole('menuitem').map((a) => a.getAttribute('href'));
    expect(items).toEqual(['/library', '/console', '/prompts', '/admin', '/settings']);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('choosing an item of the menu closes it', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Altro' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Impostazioni' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
