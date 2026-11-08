import { describe, expect, it } from 'vitest';
import { withPicked } from './facetOptions';

const opts = [
  { value: 'a', label: 'A', count: 3 },
  { value: 'b', label: 'B', count: 1 },
];

describe('withPicked', () => {
  it('leaves the options alone when every picked value is among them', () => {
    expect(withPicked(opts, ['b'])).toEqual(opts);
    expect(withPicked(opts, [])).toEqual(opts);
  });

  it('adds a picked value that has nothing left, at the end, with a 0, so it can be undone', () => {
    expect(withPicked(opts, ['a', 'z'])).toEqual([...opts, { value: 'z', label: 'z', count: 0 }]);
  });

  it('words the added value the way the caller says (a decade is "1990s", not "1990")', () => {
    expect(withPicked(opts, ['1990'], (v) => `${v}s`)).toContainEqual({ value: '1990', label: '1990s', count: 0 });
  });

  it('adds a value once, however often it is listed, and does not change what it is given', () => {
    const picked = ['z', 'z'];
    expect(withPicked(opts, picked).filter((o) => o.value === 'z')).toHaveLength(1);
    expect(opts).toHaveLength(2);
    expect(picked).toEqual(['z', 'z']);
  });
});
