import type { UiPrefs, UiPrefsPatch } from '../types';

// ADR-0026: the configuration of the site belongs to the user and lives on the server, which decides every default and validates every
// change. What the client keeps here is only (1) the merge of a partial document, written the way the server merges, so that a change shows at
// once and the server answer can replace it, and (2) a copy in the session to draw the first frame while the answer is on its way.

/** One key for the copy of the session; the `.v1` is the version of the document (`UiPrefs.v`). */
export const PREFS_CACHE_KEY = 'soundreel.uiPrefs.v1';

/** The keys that carry a value: a patch with `{ inbox: undefined }` must not erase the view. */
function defined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const key of Object.keys(obj) as Array<keyof T>) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

/**
 * The server's merge (docs/ui-prefs.md): the views page by page, the sections ALL together (order and switches), the dock replaced, the float
 * position axis by axis. A new document every time; nothing is shared with the input or with the patch.
 */
export function applyPrefsPatch(prefs: UiPrefs, patch: UiPrefsPatch): UiPrefs {
  return {
    v: 1,
    views: { ...prefs.views, ...defined(patch.views) },
    home: { sections: (patch.home?.sections ?? prefs.home.sections).map((section) => ({ ...section })) },
    player: {
      dock: patch.player?.dock ?? prefs.player.dock,
      float: { ...prefs.player.float, ...defined(patch.player?.float) },
    },
  };
}

// The values a COPY must have to be drawn from: a corrupted or old copy is «no copy», never a broken page. The server stays the authority
// (it validates what it stores and decides the starting values); these lists only guard the copy.
const INBOX_VIEWS = ['studio', 'wall', 'home'];
const LINKS_VIEWS = ['studio', 'wall'];
const DOCKS = ['bottom', 'float', 'side', 'hidden'];
const SECTION_IDS = ['resume', 'songs', 'playlists', 'collections', 'films'];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isFraction = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

function isUiPrefs(x: unknown): x is UiPrefs {
  if (!isObject(x) || x.v !== 1) return false;
  const { views, home, player } = x;
  if (!isObject(views) || !INBOX_VIEWS.includes(views.inbox as string) || !LINKS_VIEWS.includes(views.links as string)) return false;
  if (!isObject(home) || !Array.isArray(home.sections) || home.sections.length !== SECTION_IDS.length) return false;
  const seen = new Set<string>();
  for (const section of home.sections) {
    if (!isObject(section) || typeof section.visible !== 'boolean' || !SECTION_IDS.includes(section.id as string) || seen.has(section.id as string)) return false;
    seen.add(section.id as string);
  }
  if (!isObject(player) || !DOCKS.includes(player.dock as string) || !isObject(player.float)) return false;
  return isFraction(player.float.x) && isFraction(player.float.y);
}

/** The copy of the session, or null when there is none, it is garbage, it is an old shape or the storage refuses. */
export function readCachedPrefs(): UiPrefs | null {
  try {
    const raw = sessionStorage.getItem(PREFS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUiPrefs(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keeps the document the SERVER answered; a storage that refuses (private window, blocked site data) is not an error. */
export function writeCachedPrefs(prefs: UiPrefs): void {
  try {
    sessionStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(prefs));
  } catch {
    /* no copy: the next visit waits for the server */
  }
}
