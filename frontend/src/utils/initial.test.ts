import { describe, expect, it } from 'vitest';
import { initial } from './initial';

describe('the first letter of a name for a tile with no picture', () => {
  it('is the first letter in capitals, without the spaces before it', () => {
    expect(initial('  vino')).toBe('V');
  });

  it('counts an emoji as one letter, not as half a character', () => {
    expect(initial('🍷 Vino')).toBe('🍷');
  });

  it('falls back to the note, or to what the caller says, when there is no name', () => {
    expect(initial('   ')).toBe('♪');
    expect(initial('', '?')).toBe('?');
  });
});
