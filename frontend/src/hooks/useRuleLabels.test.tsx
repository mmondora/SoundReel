import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { ORDERS, describeRule } from '../utils/dynamicRule';
import type { DynamicRule } from '../types';
import { useRuleLabels } from './useRuleLabels';

const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;

// The words a summary of a dynamic rule is built from: one for every order the server knows (the playlist «Mi piace» is the rule `liked`, ADR-0028).

describe('the words of a rule summary', () => {
  beforeEach(() => {
    setStoredLanguage('en');
  });

  it('are there for every order the editor offers, each its own', () => {
    const { result } = renderHook(() => useRuleLabels(), { wrapper });
    const words = ORDERS.map((o) => result.current.orders[o]);
    expect(words.every((w) => typeof w === 'string' && w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(ORDERS.length);
  });

  it('say «Recently liked» for the likes of the person, and the summary of the playlist «Mi piace» uses it', () => {
    const { result } = renderHook(() => useRuleLabels(), { wrapper });
    expect(result.current.orders.liked).toBe('Recently liked');
    const rule: DynamicRule = { v: 1, scope: 'me', period: 'all', order: 'liked', limit: 200, minPlays: 1, downloadedOnly: false };
    expect(describeRule(rule, result.current)).toBe('Recently liked · max 200');
  });

  it('are Italian in Italian', () => {
    setStoredLanguage('it');
    const { result } = renderHook(() => useRuleLabels(), { wrapper });
    expect(result.current.orders.liked).toBe('Piaciuti di recente');
  });
});
