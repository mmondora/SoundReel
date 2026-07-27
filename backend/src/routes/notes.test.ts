import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({ listEntries: vi.fn() }));
vi.mock('../services/noteMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/noteMeta')>();
  return {
    noteKey: actual.noteKey,
    normalizeNoteCategory: actual.normalizeNoteCategory,
    listNoteMeta: vi.fn(),
  };
});
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerNotesRoutes } from './notes';
import { listEntries } from '../utils/db';
import { listNoteMeta } from '../services/noteMeta';
import type { NoteMetaRecord } from '../types';

function buildApp() {
  const app = Fastify();
  registerNotesRoutes(app);
  return app;
}

function entry(id: string, createdAt: string, notes: unknown[]) {
  return { id, createdAt, results: { notes } } as never;
}

const DUNE_NOTE = { text: 'Dune', category: 'book' };

describe('GET /api/notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dedups mentions of the same note across entries', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-02T00:00:00Z', [DUNE_NOTE]),
      entry('e2', '2026-07-01T00:00:00Z', [{ text: ' Dune ', category: 'book' }]),
    ]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    expect(res.statusCode).toBe(200);
    const { notes } = res.json();
    expect(notes).toHaveLength(1);
    expect(notes[0].noteKey).toBe('book::dune');
    expect(notes[0].mentions).toHaveLength(2);
  });

  it('mentions are newest-first', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('newer', '2026-07-02T00:00:00Z', [DUNE_NOTE]),
      entry('older', '2026-07-01T00:00:00Z', [DUNE_NOTE]),
    ]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    const { notes } = res.json();
    expect(notes[0].mentions.map((m: { entryId: string }) => m.entryId)).toEqual(['newer', 'older']);
  });

  it('category shown comes from the most recent mention, normalized', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ text: 'Dune', category: 'book' }]),
      entry('e2', '2026-07-02T00:00:00Z', [{ text: 'Dune', category: 'BOOK' }]),
    ]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    const { notes } = res.json();
    expect(notes[0].category).toBe('book');
  });

  it('an unknown raw category (e.g. legacy "note") normalizes to other, both for the noteKey and the displayed category', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ text: 'Weird one', category: 'note' }]),
    ]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    const { notes } = res.json();
    expect(notes[0].category).toBe('other');
    expect(notes[0].noteKey).toBe('other::weird one');
  });

  it('meta is left-joined by noteKey', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [DUNE_NOTE])]);
    const meta: NoteMetaRecord = {
      noteKey: 'book::dune', bookTitle: 'Dune', bookAuthor: 'Frank Herbert', bookYear: 1965,
      coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg', openlibraryUrl: 'https://openlibrary.org/works/OL1W',
      placeName: null, placeDisplayName: null, placeLat: null, placeLon: null, osmUrl: null,
      enrichedAt: '2026-07-01T00:00:00.000Z',
    };
    vi.mocked(listNoteMeta).mockResolvedValue(new Map([['book::dune', meta]]));
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    const { notes } = res.json();
    expect(notes[0].meta.bookAuthor).toBe('Frank Herbert');
  });

  it('meta is null when there is no note_meta row', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [DUNE_NOTE])]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    const { notes } = res.json();
    expect(notes[0].meta).toBeNull();
  });

  it('skips malformed note objects without failing', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [
        null,
        { noText: true },
        { text: '   ', category: 'book' },
        { text: 5, category: 'book' },
        DUNE_NOTE,
      ]),
    ]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toHaveLength(1);
  });

  it('tolerates entries with a non-array results.notes', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      { id: 'e1', createdAt: '2026-07-01T00:00:00Z', results: {} } as never,
    ]);
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toHaveLength(0);
  });

  it('500 and logs when aggregation fails', async () => {
    vi.mocked(listEntries).mockRejectedValue(new Error('db down'));
    vi.mocked(listNoteMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/notes' });
    expect(res.statusCode).toBe(500);
  });
});
