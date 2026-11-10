import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UrlInput } from './UrlInput';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';

// «Incolla un link» of the top bar opens the Inbox with #paste: the field is ready to be typed in.

function renderAt(path: string) {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <UrlInput onSubmit={vi.fn()} loading={false} error={null} successStatus={null} />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setStoredLanguage('it');
});

describe('UrlInput and the #paste of the top bar', () => {
  it('takes the focus when the page opens with #paste', () => {
    renderAt('/#paste');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('does not steal the focus on a normal visit', () => {
    renderAt('/');
    expect(screen.getByRole('textbox')).not.toHaveFocus();
  });

  it('another hash does not take it either', () => {
    renderAt('/#altro');
    expect(screen.getByRole('textbox')).not.toHaveFocus();
  });
});
