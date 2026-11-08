import { useEffect, useState } from 'react';
import { getEntry } from '../services/api';

// The thumbnail of the journal entry that mentions a song is the second choice for the player cover. It is looked
// up one entry at a time, and only when the song has no cover of its own, so the player page stays light.
const cache = new Map<string, string | null>();

export function resetEntryThumbnailCache(): void {
  cache.clear();
}

export function useEntryThumbnail(entryId: string | null | undefined, enabled: boolean): string | null {
  const [, force] = useState(0);

  useEffect(() => {
    if (!enabled || !entryId || cache.has(entryId)) return;
    let cancelled = false;
    getEntry(entryId)
      .then((entry) => { cache.set(entryId, entry.thumbnailUrl ?? null); })
      .catch(() => { cache.set(entryId, null); })
      .finally(() => { if (!cancelled) force((n) => n + 1); });
    return () => { cancelled = true; };
  }, [entryId, enabled]);

  return enabled && entryId ? (cache.get(entryId) ?? null) : null;
}
