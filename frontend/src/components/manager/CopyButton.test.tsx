import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CopyButton } from './CopyButton';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';

const mountButton = () =>
  render(
    <LanguageProvider>
      <CopyButton value="~/Music/SoundReel/X.mp3" what="geekom disk (FS)" />
    </LanguageProvider>,
  );

const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

beforeEach(() => {
  setStoredLanguage('en');
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setClipboard(undefined);
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe('CopyButton', () => {
  it('is named after what it copies', () => {
    setClipboard({ writeText: vi.fn() });
    mountButton();
    expect(screen.getByRole('button', { name: 'Copy geekom disk (FS)' })).toBeInTheDocument();
  });

  it('copies the exact value, says "Copied" (also to screen readers) and goes back to "Copy" after 2 s', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    mountButton();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(writeText).toHaveBeenCalledWith('~/Music/SoundReel/X.mp3');
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole('button')).toHaveTextContent('Copy');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('says so when the clipboard refuses', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    mountButton();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button')).toHaveTextContent('Copy failed');
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed');
  });

  it('without the async clipboard (plain http) it falls back to selecting text', async () => {
    setClipboard(undefined);
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    mountButton();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(exec).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    expect(document.querySelector('textarea')).toBeNull(); // the helper textarea is cleaned up
  });

  it('the fallback failing is reported, not swallowed', async () => {
    setClipboard(undefined);
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
    mountButton();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button')).toHaveTextContent('Copy failed');
  });

  it('leaves no timer running after unmount', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const { unmount } = mountButton();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
