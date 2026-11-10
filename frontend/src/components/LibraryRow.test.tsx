import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LibraryRow } from './LibraryRow';
import { LanguageProvider } from '../i18n';
import { translations } from '../i18n/translations';
import type { EntrySummary } from '../types';

// A post of a list (the Link page, the Inbox): the whole row opens it, and it says what is going on with it — being analysed, failed — and what the
// enrichment found (the verdict), because the Inbox is where the new posts arrive.

const t = translations.en;

const entry = (over: Partial<EntrySummary> = {}): EntrySummary => ({
  id: 'e1', sourceUrl: 'https://instagram.com/reel/e1', sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-11-10T10:00:00.000Z', summary: 'A POST', songCount: 0, filmCount: 0, noteCount: 0, tags: [], ...over,
});

const renderRow = (e: EntrySummary) => render(
  <MemoryRouter><LanguageProvider><ul><LibraryRow entry={e} selected={false} onSelect={vi.fn()} /></ul></LanguageProvider></MemoryRouter>,
);

describe('a post of the list — its state', () => {
  it('a post being analysed says so', () => {
    renderRow(entry({ status: 'processing' }));
    expect(screen.getByRole('status', { name: t.statusProcessing })).toBeInTheDocument();
  });

  it('a post that failed says so', () => {
    renderRow(entry({ status: 'error' }));
    expect(screen.getByRole('img', { name: t.error })).toBeInTheDocument();
  });

  it('a post that is done says nothing', () => {
    renderRow(entry());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('img', { name: t.error })).toBeNull();
  });
});

describe('a post of the list — the verdict', () => {
  it('shows the icon of what the enrichment found, with the label and the confidence on hover', () => {
    renderRow(entry({ verdict: { label: 'false', confidence: 82 } }));
    const icon = screen.getByTitle('FALSE (82%)');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass('library-verdict');
  });

  it('shows nothing when there is none, or when the server does not send it', () => {
    const { container } = renderRow(entry({ verdict: null }));
    expect(container.querySelector('.library-verdict')).toBeNull();
    const again = renderRow(entry());
    expect(again.container.querySelector('.library-verdict')).toBeNull();
  });

  it('a label the site does not know is still shown, not lost: a neutral dot in the colour of a warning', () => {
    renderRow(entry({ verdict: { label: 'novel', confidence: 50 } }));
    const icon = screen.getByTitle('NOVEL (50%)');
    expect(icon).toHaveTextContent('•');
    expect(icon).toHaveClass('enrichment-verdict-warning');
  });
});
