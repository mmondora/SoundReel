import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORM,
  LIMIT_MAX,
  crossesMidnight,
  describeRule,
  formToRule,
  isTime,
  periodOptions,
  ruleToForm,
  validateForm,
} from './dynamicRule';
import type { RuleForm, RuleLabels } from './dynamicRule';
import type { DynamicRule } from '../types';

const LABELS: RuleLabels = {
  orders: { most_played: 'Più ascoltate', least_played: 'Meno ascoltate', recent: 'Recenti', never_played: 'Mai ascoltate', newest: 'Aggiunte di recente' },
  lastDays: (n) => `ultimi ${n} giorni`,
  allTime: 'sempre',
  daysShort: ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'],
  family: 'famiglia',
  max: (n) => `max ${n}`,
  downloadedOnly: 'solo scaricate',
  midnight: 'oltre la mezzanotte',
};

const form = (patch: Partial<RuleForm> = {}): RuleForm => ({ ...DEFAULT_FORM, name: 'Mattina', ...patch });

describe('formToRule', () => {
  it('builds the wire rule of the contract', () => {
    const rule = formToRule(form({
      scope: 'family', period: '30', windowEnabled: true, from: '07:00', to: '08:00', days: [5, 1, 3, 3],
      genres: ['Rock', 'Jazz'], order: 'most_played', limit: '50', minPlays: '1', downloadedOnly: true,
    }));
    expect(rule).toEqual({
      v: 1,
      scope: 'family',
      period: { days: 30 },
      window: { from: '07:00', to: '08:00', days: [1, 3, 5] },
      order: 'most_played',
      limit: 50,
      minPlays: 1,
      genres: ['Rock', 'Jazz'],
      downloadedOnly: true,
    });
  });

  it('leaves out what is not set: no window, every day, no genres', () => {
    expect(formToRule(form())).toEqual({ v: 1, scope: 'me', period: { days: 30 }, order: 'most_played', limit: 50, minPlays: 1, downloadedOnly: false });
    expect(formToRule(form({ windowEnabled: true, days: [] })).window).toEqual({ from: '07:00', to: '08:00' });
    expect(formToRule(form({ windowEnabled: true, days: [1, 2, 3, 4, 5, 6, 7] })).window).toEqual({ from: '07:00', to: '08:00' });
  });

  it('"all time" is the string "all"', () => {
    expect(formToRule(form({ period: 'all' })).period).toBe('all');
  });

  it('a window crossing midnight is kept as typed (from > to)', () => {
    expect(formToRule(form({ windowEnabled: true, from: '22:00', to: '06:00' })).window).toEqual({ from: '22:00', to: '06:00' });
  });

  it('"never played" has no time window (it does not apply)', () => {
    expect(formToRule(form({ order: 'never_played', windowEnabled: true })).window).toBeUndefined();
  });

  it('"newest" (the library, the last added first) has no time window either, and keeps its genres', () => {
    const rule = formToRule(form({ order: 'newest', windowEnabled: true, genres: ['R&B/Soul'], limit: '200' }));
    expect(rule.window).toBeUndefined();
    expect(rule).toMatchObject({ order: 'newest', genres: ['R&B/Soul'], limit: 200 });
  });

  it('the rule the server made for a playlist of a genre comes back into the editor as it is (it must not turn into "most played")', () => {
    const fromServer: DynamicRule = { v: 1, scope: 'me', period: 'all', order: 'newest', limit: 200, minPlays: 1, genres: ['R&B/Soul'], downloadedOnly: false };
    const back = ruleToForm(fromServer, 'Soul da ascoltare');
    expect(back.order).toBe('newest');
    expect(formToRule(back)).toMatchObject({ order: 'newest', genres: ['R&B/Soul'], period: 'all', limit: 200 });
  });

  it('limit is clamped to 1–200, an empty or bad number falls back to the defaults', () => {
    expect(formToRule(form({ limit: '0' })).limit).toBe(1);
    expect(formToRule(form({ limit: '999' })).limit).toBe(LIMIT_MAX);
    expect(formToRule(form({ limit: '' })).limit).toBe(50);
    expect(formToRule(form({ limit: 'abc' })).limit).toBe(50);
    expect(formToRule(form({ limit: '12.7' })).limit).toBe(12);
    expect(formToRule(form({ minPlays: '' })).minPlays).toBe(1);
    expect(formToRule(form({ minPlays: '-3' })).minPlays).toBe(0);
  });
});

describe('ruleToForm', () => {
  const rule: DynamicRule = {
    v: 1, scope: 'family', period: { days: 90 }, window: { from: '22:00', to: '06:00', days: [5, 6] },
    order: 'least_played', limit: 25, minPlays: 2, genres: ['Trap'], downloadedOnly: true,
  };

  it('is the inverse of formToRule', () => {
    expect(formToRule(ruleToForm(rule, 'x'))).toEqual(rule);
    const noWindow: DynamicRule = { v: 1, scope: 'me', period: 'all', order: 'recent', limit: 10, minPlays: 0, downloadedOnly: false };
    expect(formToRule(ruleToForm(noWindow))).toEqual(noWindow);
  });

  it('fills the form (preset → editor)', () => {
    expect(ruleToForm(rule, 'Notte')).toMatchObject({
      name: 'Notte', scope: 'family', period: '90', windowEnabled: true, from: '22:00', to: '06:00', days: [5, 6],
      genres: ['Trap'], order: 'least_played', limit: '25', minPlays: '2', downloadedOnly: true,
    });
    expect(ruleToForm(null, 'N')).toEqual({ ...DEFAULT_FORM, name: 'N' });
  });

  it('survives a partial or odd rule', () => {
    const odd = ruleToForm({ v: 1, scope: 'me', order: 'bogus' } as unknown as DynamicRule);
    expect(odd.order).toBe('most_played');
    expect(odd.limit).toBe('50');
  });
});

describe('validateForm', () => {
  const codes = (f: RuleForm, needsName = true) => validateForm(f, { needsName }).map((i) => i.code);

  it('a good form has no issues', () => {
    expect(codes(form())).toEqual([]);
  });

  it('the name is required (and bounded) only when creating', () => {
    expect(codes(form({ name: '   ' }))).toEqual(['nameRequired']);
    expect(codes(form({ name: 'x'.repeat(81) }))).toEqual(['nameTooLong']);
    expect(codes(form({ name: '' }), false)).toEqual([]);
  });

  it('limit must be an integer between 1 and 200', () => {
    for (const limit of ['0', '201', '', 'x', '1.5', '-1']) expect(codes(form({ limit }))).toContain('limitRange');
    for (const limit of ['1', '50', '200']) expect(codes(form({ limit }))).not.toContain('limitRange');
  });

  it('minPlays must be a whole number ≥ 0, unless the order ignores it', () => {
    expect(codes(form({ minPlays: '-1' }))).toContain('minPlaysRange');
    expect(codes(form({ minPlays: '' }))).toContain('minPlaysRange');
    expect(codes(form({ minPlays: '0' }))).not.toContain('minPlaysRange');
    expect(codes(form({ order: 'never_played', minPlays: '' }))).not.toContain('minPlaysRange');
  });

  it('the time window needs two valid times that differ; crossing midnight is fine', () => {
    expect(codes(form({ windowEnabled: true, from: '7:00' }))).toContain('windowTime');
    expect(codes(form({ windowEnabled: true, to: '24:00' }))).toContain('windowTime');
    expect(codes(form({ windowEnabled: true, from: '08:00', to: '08:00' }))).toContain('windowEmpty');
    expect(codes(form({ windowEnabled: true, from: '22:00', to: '06:00' }))).toEqual([]);
    // a disabled window is not validated
    expect(codes(form({ windowEnabled: false, from: 'x', to: 'y' }))).toEqual([]);
    // and "never played" ignores it
    expect(codes(form({ windowEnabled: true, from: 'x', order: 'never_played' }))).toEqual([]);
    // "newest" does not look at the listening: no minimum of plays and no window to get wrong
    expect(codes(form({ order: 'newest', minPlays: '', windowEnabled: true, from: 'x' }))).toEqual([]);
    expect(codes(form({ order: 'most_played', minPlays: '' }))).toContain('minPlaysRange');
  });
});

describe('crossesMidnight / isTime', () => {
  it('from > to crosses midnight', () => {
    expect(crossesMidnight('22:00', '06:00')).toBe(true);
    expect(crossesMidnight('07:00', '08:00')).toBe(false);
    expect(crossesMidnight('07:00', '07:00')).toBe(false);
    expect(crossesMidnight('bad', '06:00')).toBe(false);
  });

  it('HH:MM only', () => {
    expect(isTime('00:00')).toBe(true);
    expect(isTime('23:59')).toBe(true);
    expect(isTime('24:00')).toBe(false);
    expect(isTime('7:00')).toBe(false);
    expect(isTime('07:60')).toBe(false);
  });
});

describe('describeRule', () => {
  it('reads like the backend summary', () => {
    expect(describeRule({ v: 1, scope: 'me', period: { days: 30 }, window: { from: '07:00', to: '08:00' }, order: 'most_played', limit: 50, minPlays: 1, downloadedOnly: false }, LABELS))
      .toBe('Più ascoltate · 07:00–08:00 · ultimi 30 giorni · max 50');
  });

  it('mentions midnight crossing, days, genres, family and downloaded-only', () => {
    expect(describeRule({ v: 1, scope: 'family', period: 'all', window: { from: '22:00', to: '06:00', days: [5, 6] }, order: 'least_played', limit: 20, minPlays: 1, genres: ['Trap'], downloadedOnly: true }, LABELS))
      .toBe('Meno ascoltate · 22:00–06:00 (oltre la mezzanotte) · ven sab · sempre · Trap · famiglia · solo scaricate · max 20');
  });

  it('"newest" says only the genre and the maximum: no window, no period, no family', () => {
    expect(describeRule({ v: 1, scope: 'family', period: { days: 7 }, window: { from: '07:00', to: '08:00' }, order: 'newest', limit: 200, minPlays: 1, genres: ['R&B/Soul'], downloadedOnly: false }, LABELS))
      .toBe('Aggiunte di recente · R&B/Soul · max 200');
    expect(describeRule({ v: 1, scope: 'me', period: 'all', order: 'newest', limit: 20, minPlays: 1, downloadedOnly: true }, LABELS)).toBe('Aggiunte di recente · solo scaricate · max 20');
  });

  it('"never played" does not mention a window', () => {
    expect(describeRule({ v: 1, scope: 'me', period: { days: 7 }, window: { from: '07:00', to: '08:00' }, order: 'never_played', limit: 5, minPlays: 1, downloadedOnly: false }, LABELS))
      .toBe('Mai ascoltate · ultimi 7 giorni · max 5');
  });
});

describe('periodOptions', () => {
  it('the usual five, plus an unusual period a preset brought in, in order', () => {
    expect(periodOptions('30')).toEqual(['7', '30', '90', '365', 'all']);
    expect(periodOptions('14')).toEqual(['7', '14', '30', '90', '365', 'all']);
    expect(periodOptions('all')).toEqual(['7', '30', '90', '365', 'all']);
  });
});
