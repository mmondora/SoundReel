import { describe, it, expect } from 'vitest';
import { matchService, streamBadgeClass, streamTypeLabel } from './FilmCard';
import { translations } from '../i18n/translations';

describe('matchService', () => {
  it('matches the six canonical platform names', () => {
    expect(matchService('Netflix')).toBe('netflix');
    expect(matchService('Prime Video')).toBe('primeVideo');
    expect(matchService('RaiPlay')).toBe('raiPlay');
    expect(matchService('NOW')).toBe('now');
    expect(matchService('Disney Plus')).toBe('disneyPlus');
    expect(matchService('Apple TV')).toBe('appleTv');
  });

  it('matches Disney+ variants (regression: label "D+" never matched these)', () => {
    expect(matchService('Disney Plus')).toBe('disneyPlus');
    expect(matchService('Disney+')).toBe('disneyPlus');
  });

  it('does not false-positive on platforms that merely contain "TV" (regression: label "TV")', () => {
    expect(matchService('Rakuten TV')).toBeUndefined();
    expect(matchService('ITVX')).toBeUndefined();
  });

  it('does not match unrelated platforms', () => {
    expect(matchService('Paramount+')).toBeUndefined();
  });

  it('requires a word boundary, not a bare substring (regression: "now" inside "Snowpiercer", "prime" inside "Primetime")', () => {
    expect(matchService('Snowpiercer TV')).toBeUndefined();
    expect(matchService('Primetime Channel')).toBeUndefined();
  });

  it('still matches short aliases as whole words, including the "+" edge case', () => {
    expect(matchService('NOW')).toBe('now');
    expect(matchService('Disney+')).toBe('disneyPlus');
  });

  it('prefers a longer, more specific alias over a shorter one that would over-match', () => {
    expect(matchService('Amazon Prime Video')).toBe('primeVideo');
    expect(matchService('Now TV')).toBe('now');
  });

  it('is case-insensitive', () => {
    expect(matchService('nEtFlIx')).toBe('netflix');
    expect(matchService('APPLE TV')).toBe('appleTv');
  });
});

describe('streamBadgeClass', () => {
  it('maps each streaming option type to its badge class', () => {
    expect(streamBadgeClass('FREE')).toBe('stream-free');
    expect(streamBadgeClass('SUBSCRIPTION')).toBe('stream-sub');
    expect(streamBadgeClass('RENTAL')).toBe('stream-paid');
    expect(streamBadgeClass('PURCHASE')).toBe('stream-paid');
  });
});

describe('streamTypeLabel', () => {
  const t = translations.en;

  it('maps each streaming option type to its localized label', () => {
    expect(streamTypeLabel('FREE', t)).toBe(t.filmsStreamFree);
    expect(streamTypeLabel('SUBSCRIPTION', t)).toBe(t.filmsStreamSub);
    expect(streamTypeLabel('RENTAL', t)).toBe(t.filmsStreamRent);
    expect(streamTypeLabel('PURCHASE', t)).toBe(t.filmsStreamBuy);
  });
});
