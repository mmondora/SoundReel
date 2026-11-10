import { describe, expect, it } from 'vitest';
import { venueKindLabel } from './venueKind';
import { translations } from '../i18n/translations';

const KINDS = ['restaurant', 'pizzeria', 'bar', 'cafe', 'hotel', 'refuge', 'winery', 'shop'];

describe('the kind of venue in the words of the page', () => {
  it('every kind the server knows has a name in both languages', () => {
    for (const kind of KINDS) {
      expect(venueKindLabel(kind, translations.en), `en ${kind}`).toBeTruthy();
      expect(venueKindLabel(kind, translations.it), `it ${kind}`).toBeTruthy();
    }
  });

  it('is the word of the language: «winery» in English, «cantina» in Italian', () => {
    expect(venueKindLabel('winery', translations.en)).toBe('winery');
    expect(venueKindLabel('winery', translations.it)).toBe('cantina');
    expect(venueKindLabel('refuge', translations.it)).toBe('rifugio');
  });

  it('«other» says nothing about the venue', () => {
    expect(venueKindLabel('other', translations.en)).toBeNull();
  });

  it('a kind the site does not know is written as it came, not lost', () => {
    expect(venueKindLabel('castle', translations.en)).toBe('castle');
  });
});
