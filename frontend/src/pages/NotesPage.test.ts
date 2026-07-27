import { describe, it, expect } from 'vitest';
import { buildBookByline } from './NotesPage';

describe('buildBookByline', () => {
  it('joins author and year with a space', () => {
    expect(buildBookByline('Frank Herbert', 1965)).toBe('Frank Herbert (1965)');
  });

  it('renders just the year, with no leading space, when author is null', () => {
    expect(buildBookByline(null, 1965)).toBe('(1965)');
  });

  it('renders just the author, with no trailing space, when year is null', () => {
    expect(buildBookByline('Frank Herbert', null)).toBe('Frank Herbert');
  });

  it('returns an empty string when both are null', () => {
    expect(buildBookByline(null, null)).toBe('');
  });
});
