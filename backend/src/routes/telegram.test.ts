import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../utils/db', () => ({
  countEntries: vi.fn().mockResolvedValue(0),
  listEntries: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/promptLoader', () => ({
  getPrompt: vi.fn().mockRejectedValue(new Error('not mocked')),
  renderTemplate: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/debugLogger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    startTimer: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    endTimer: vi.fn(),
  })),
}));

import {
  isSpotifyUrl,
  extractUrl,
  escapeHtml,
  truncateForTelegram,
  pickTitle,
  type TelegramMessage,
  type AnalyzeResult,
} from './telegram';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isSpotifyUrl
// ---------------------------------------------------------------------------
describe('isSpotifyUrl', () => {
  it('track URL → true', () => {
    expect(isSpotifyUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')).toBe(true);
  });

  it('playlist URL → true', () => {
    expect(isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe(true);
  });

  it('album URL → true', () => {
    expect(isSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')).toBe(true);
  });

  it('non-Spotify URL → false', () => {
    expect(isSpotifyUrl('https://www.youtube.com/watch?v=abc123')).toBe(false);
  });

  it('http Spotify track URL → true', () => {
    expect(isSpotifyUrl('http://open.spotify.com/track/abc')).toBe(true);
  });

  it('spotify.com root (no path) → false', () => {
    expect(isSpotifyUrl('https://open.spotify.com/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractUrl
// ---------------------------------------------------------------------------
describe('extractUrl', () => {
  it('message with url entity → returns entity-based substring', () => {
    const message: TelegramMessage = {
      message_id: 1,
      chat: { id: 123 },
      text: 'Check this https://example.com/path out',
      entities: [{ type: 'url', offset: 11, length: 24 }],
    };
    expect(extractUrl(message)).toBe('https://example.com/path');
  });

  it('message without entities, URL in text → returns regex match', () => {
    const message: TelegramMessage = {
      message_id: 2,
      chat: { id: 123 },
      text: 'See https://instagram.com/reel/abc',
    };
    expect(extractUrl(message)).toBe('https://instagram.com/reel/abc');
  });

  it('message with no text → null', () => {
    const message: TelegramMessage = {
      message_id: 3,
      chat: { id: 123 },
    };
    expect(extractUrl(message)).toBeNull();
  });

  it('message with text but no URL → null', () => {
    const message: TelegramMessage = {
      message_id: 4,
      chat: { id: 123 },
      text: 'hello there, no link here',
    };
    expect(extractUrl(message)).toBeNull();
  });

  it('entity with non-url type is ignored, falls back to regex', () => {
    const message: TelegramMessage = {
      message_id: 5,
      chat: { id: 123 },
      text: 'Bold text and https://example.com',
      entities: [{ type: 'bold', offset: 0, length: 9 }],
    };
    expect(extractUrl(message)).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
describe('escapeHtml', () => {
  it('& → &amp;', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('<div> → &lt;div&gt;', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('combined < & > → all escaped', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('string with no special chars → unchanged', () => {
    expect(escapeHtml('Hello world')).toBe('Hello world');
  });

  it('multiple ampersands → all escaped', () => {
    expect(escapeHtml('a & b & c')).toBe('a &amp; b &amp; c');
  });
});

// ---------------------------------------------------------------------------
// truncateForTelegram
// ---------------------------------------------------------------------------
describe('truncateForTelegram', () => {
  it('string shorter than max → returned trimmed and whitespace-collapsed', () => {
    expect(truncateForTelegram('Hello world', 20)).toBe('Hello world');
  });

  it('string longer than max → truncated + …', () => {
    // max=10 → slice(0,9).trimEnd() + '…'
    const result = truncateForTelegram('Hello world!', 10);
    expect(result).toBe('Hello wor…');
    expect(result.length).toBe(10);
  });

  it('collapses multiple spaces', () => {
    expect(truncateForTelegram('Hello   world', 50)).toBe('Hello world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(truncateForTelegram('  trimmed  ', 50)).toBe('trimmed');
  });

  it('exactly at max length → not truncated', () => {
    const s = 'abcde';
    expect(truncateForTelegram(s, 5)).toBe('abcde');
  });

  it('one character over max → truncated', () => {
    const s = 'abcdef';
    // max=5 → slice(0,4).trimEnd() + '…' = 'abcd…'
    expect(truncateForTelegram(s, 5)).toBe('abcd…');
  });
});

// ---------------------------------------------------------------------------
// pickTitle
// ---------------------------------------------------------------------------
function makeAnalyzeResult(overrides: {
  caption?: string | null;
  sourceUrl?: string;
  summary?: string | null;
} = {}): AnalyzeResult {
  return {
    success: true,
    entryId: 'test-id',
    entry: {
      caption: overrides.caption !== undefined ? overrides.caption : null,
      sourceUrl: overrides.sourceUrl,
      results: {
        songs: [],
        films: [],
        notes: [],
        links: [],
        tags: [],
        summary: overrides.summary !== undefined ? overrides.summary : null,
      },
    },
  };
}

describe('pickTitle', () => {
  it('has caption → returns first line, max 90 chars', () => {
    const result = makeAnalyzeResult({ caption: 'First line\nSecond line' });
    expect(pickTitle(result, null)).toBe('First line');
  });

  it('caption longer than 90 chars → truncated at 90', () => {
    const longCaption = 'A'.repeat(100);
    const result = makeAnalyzeResult({ caption: longCaption });
    expect(pickTitle(result, null)).toBe('A'.repeat(90));
  });

  it('no caption, has summary → summary max 80 chars', () => {
    const summary = 'This is a great summary about the video content';
    const result = makeAnalyzeResult({ caption: null });
    expect(pickTitle(result, summary)).toBe(summary);
  });

  it('no caption, summary longer than 80 → truncated at 80', () => {
    const summary = 'S'.repeat(100);
    const result = makeAnalyzeResult({ caption: null });
    expect(pickTitle(result, summary)).toBe('S'.repeat(80));
  });

  it('no caption, no summary, has sourceUrl → hostname without www', () => {
    const result = makeAnalyzeResult({ caption: null, sourceUrl: 'https://www.instagram.com/reel/abc' });
    expect(pickTitle(result, null)).toBe('instagram.com');
  });

  it('no caption, no summary, sourceUrl without www → hostname as-is', () => {
    const result = makeAnalyzeResult({ caption: null, sourceUrl: 'https://tiktok.com/video/123' });
    expect(pickTitle(result, null)).toBe('tiktok.com');
  });

  it('no caption, no summary, no sourceUrl → SoundReel', () => {
    const result = makeAnalyzeResult({ caption: null });
    expect(pickTitle(result, null)).toBe('SoundReel');
  });

  it('no entry at all → SoundReel', () => {
    const result: AnalyzeResult = { success: false };
    expect(pickTitle(result, null)).toBe('SoundReel');
  });

  it('empty caption string → falls through to summary', () => {
    const result = makeAnalyzeResult({ caption: '' });
    expect(pickTitle(result, 'Fallback summary')).toBe('Fallback summary');
  });
});
