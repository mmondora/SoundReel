import { describe, expect, it } from 'vitest';
import { pageFromParam } from './pageParam';

// `?pagina=3` in the address of the Inbox: the page the person is on, so the back button and a link to a page work.

describe('the page in the address', () => {
  it('is the number that was written', () => {
    expect(pageFromParam('3')).toBe(3);
    expect(pageFromParam('44')).toBe(44);
    expect(pageFromParam('007')).toBe(7);
  });

  it.each([null, '', '0', '-2', 'abc', '2abc', '2.7', ' 3', '1e3', 'NaN', '+4'])('%s is the first page', (raw) => {
    expect(pageFromParam(raw)).toBe(1);
  });

  it('a number that is silly is brought back to something a list can have', () => {
    expect(pageFromParam('99999999999999999999999')).toBe(1_000_000);
  });
});
