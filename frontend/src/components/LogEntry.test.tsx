import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogEntry } from './LogEntry';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import type { LogEntry as LogEntryType } from '../types';

const log = (data: Record<string, unknown> | null): LogEntryType => ({
  id: '1', timestamp: '2026-11-08T07:00:00.000Z', level: 'info', function: 'sync',
  message: 'mike (iPhone di Michele) ha avviato il sync di «Road trip»', data, entryId: null, durationMs: null, error: null,
});

const renderLog = (l: LogEntryType) => {
  setStoredLanguage('en');
  return render(<LanguageProvider><LogEntry log={l} /></LanguageProvider>);
};

describe('LogEntry actor chip', () => {
  it('shows "user · device" when the line carries an actor', () => {
    renderLog(log({ action: 'prepare', actor: { user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' } }));
    const chip = screen.getByText('mike · iPhone di Michele');
    expect(chip).toHaveClass('log-actor');
    expect(chip).toHaveAttribute('title', 'Who: mike · iPhone di Michele (mondrop)');
  });

  it('on the web (no device) it is just the user', () => {
    renderLog(log({ action: 'create', actor: { user: 'sara', device: null, channel: 'web' } }));
    expect(screen.getByText('sara')).toHaveClass('log-actor');
  });

  it('the worker shows up as "sistema", visually quieter', () => {
    renderLog(log({ action: 'done', actor: { user: 'sistema', device: null, channel: 'system' } }));
    expect(screen.getByText('sistema')).toHaveClass('log-actor-system');
  });

  it('no chip for ordinary pipeline lines', () => {
    const { container } = renderLog(log({ platform: 'instagram' }));
    expect(container.querySelector('.log-actor')).toBeNull();
    const none = renderLog(log(null));
    expect(none.container.querySelector('.log-actor')).toBeNull();
  });
});
