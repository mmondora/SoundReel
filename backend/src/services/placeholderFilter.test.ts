import { describe, it, expect } from 'vitest';
import { isPlaceholderValue, isPlaceholderText } from './placeholderFilter';

describe('isPlaceholderValue', () => {
  it('rejects a bare ellipsis, the prompt template placeholder', () => {
    expect(isPlaceholderValue('...')).toBe(true);
    expect(isPlaceholderValue('....')).toBe(true);
    expect(isPlaceholderValue('…')).toBe(true);
    expect(isPlaceholderValue('  ...  ')).toBe(true);
  });

  it('rejects the template\'s "... o null" pattern', () => {
    expect(isPlaceholderValue('... o null')).toBe(true);
    expect(isPlaceholderValue('regista o null')).toBe(true);
    expect(isPlaceholderValue('anno o null')).toBe(true);
  });

  it('rejects null-ish literals the model echoed as text', () => {
    expect(isPlaceholderValue('null')).toBe(true);
    expect(isPlaceholderValue('NULL')).toBe(true);
    expect(isPlaceholderValue('undefined')).toBe(true);
    expect(isPlaceholderValue('n/a')).toBe(true);
    expect(isPlaceholderValue('N/A')).toBe(true);
  });

  it('rejects empty and whitespace-only values', () => {
    expect(isPlaceholderValue('')).toBe(true);
    expect(isPlaceholderValue('   ')).toBe(true);
    expect(isPlaceholderValue(null)).toBe(true);
    expect(isPlaceholderValue(undefined)).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(isPlaceholderValue(42 as unknown as string)).toBe(true);
    expect(isPlaceholderValue({} as unknown as string)).toBe(true);
  });

  // Short titles are legitimate all over the real data — brevity must never be
  // treated as a junk signal or genuine entries get silently dropped.
  it('keeps short but real titles', () => {
    for (const real of ['Ink', 'Red', 'F1', 'Do', "Ma'", 'Tim', 'o3', 'US', 'HW', 'R5']) {
      expect(isPlaceholderValue(real)).toBe(false);
    }
  });

  it('keeps normal titles', () => {
    expect(isPlaceholderValue('Bohemian Rhapsody')).toBe(false);
    expect(isPlaceholderValue('Blade Runner')).toBe(false);
  });

  it('keeps titles that merely contain dots', () => {
    expect(isPlaceholderValue('S.W.A.T.')).toBe(false);
    expect(isPlaceholderValue('Mr. Robot')).toBe(false);
    expect(isPlaceholderValue('...And Justice for All')).toBe(false);
  });

  it('keeps a title that legitimately contains the word null', () => {
    expect(isPlaceholderValue('Null Object Pattern')).toBe(false);
  });
});

describe('isPlaceholderText', () => {
  // Repair passes must not rewrite a record just to normalise a missing field.
  it('ignores absent, null and empty values', () => {
    expect(isPlaceholderText(undefined)).toBe(false);
    expect(isPlaceholderText(null)).toBe(false);
    expect(isPlaceholderText('')).toBe(false);
    expect(isPlaceholderText('   ')).toBe(false);
  });

  it('flags real placeholder text', () => {
    expect(isPlaceholderText('...')).toBe(true);
    expect(isPlaceholderText('null')).toBe(true);
    expect(isPlaceholderText('anno o null')).toBe(true);
  });

  it('leaves genuine values alone', () => {
    expect(isPlaceholderText('King Crimson')).toBe(false);
    expect(isPlaceholderText('Red')).toBe(false);
  });
});
