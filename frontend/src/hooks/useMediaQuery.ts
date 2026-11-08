import { useEffect, useState } from 'react';

/** Phones: the same breakpoint as the `@media (max-width: 640px)` rules of the stylesheets. */
export const PHONE_QUERY = '(max-width: 640px)';

const read = (query: string): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;

/**
 * Whether a CSS media query matches, kept up to date (a phone turned sideways, a window resized). Where the browser
 * has no `matchMedia` (a test environment) it never matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}
