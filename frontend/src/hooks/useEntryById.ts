import { useEffect, useState } from 'react';
import { getEntry } from '../services/api';
import type { Entry } from '../types';

export interface EntryById {
  /** The post, once it has been read (or at once when it is among the known ones). */
  entry: Entry | null;
  /** True from the moment an id is given until the answer (good or not) has come. */
  loading: boolean;
}

const NONE: readonly Entry[] = [];

/**
 * The post with this id, for the pages that list only summaries (the Link page, the Inbox): it is read once per id, a post already among `known` is
 * not read at all, and the slow answer for the post that was open before never replaces the one open now. A post that cannot be read is `null`.
 * `version`: when it changes (the library changed: an analysis moved) the same post is read again; the post on the screen stays until the answer comes,
 * and a re-read that fails leaves it.
 */
export function useEntryById(id: string | null, known: readonly Entry[] = NONE, version = 0): EntryById {
  const fromKnown = id ? known.find((e) => e.id === id) ?? null : null;
  const [fetched, setFetched] = useState<{ id: string; entry: Entry | null } | null>(null);

  useEffect(() => {
    if (!id || fromKnown) return undefined;
    let current = true;
    getEntry(id)
      .then((entry) => { if (current) setFetched({ id, entry }); })
      .catch(() => { if (current) setFetched((prev) => (prev && prev.id === id && prev.entry ? prev : { id, entry: null })); });
    return () => { current = false; };
  }, [id, fromKnown, version]);

  if (!id) return { entry: null, loading: false };
  if (fromKnown) return { entry: fromKnown, loading: false };
  if (fetched && fetched.id === id) return { entry: fetched.entry, loading: false };
  return { entry: null, loading: true };
}
