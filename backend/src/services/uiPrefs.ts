/**
 * The configuration of the site, one small document per user (ADR-0026, spec 2026-11-10-web-look-and-feel-rethink-design.md §3.3).
 * Michele, 10 November: «configurazione per utente - di default vista A».
 *
 * What a user can configure: the VIEW of a page (Studio, Bacheca, Home), the SECTIONS of the Home (which, and in which order) and where the
 * PLAYER is (bottom, floating with its position, at the side, hidden). The colours are NOT here (ADR-0025: one style for the site and the app).
 *
 * Rule P (ADR-0018): the server owns the defaults and answers the COMPLETE document, so every client draws the same thing and none carries a table
 * of defaults. The database keeps only what the user CHOSE (a sparse document): a default can then change in one place. Everything that comes in is
 * checked against a closed schema and refused with the name of the key (`invalid_prefs:views.links`); everything that comes OUT of the database is
 * checked again, key by key, and a value the code no longer knows falls back to the default of that key (never an error).
 */
import { query, withClient } from '../utils/db';

/** The sections of the Home, in the order they come by default. Each appears exactly once in a configuration. */
export const SECTION_IDS = ['resume', 'songs', 'playlists', 'collections', 'films'] as const;
export const DOCKS = ['bottom', 'float', 'side', 'hidden'] as const;
/** The views a page can have: the Inbox can also be the Home (the sections), the Link page is a list or a wall. */
const VIEWS = { inbox: ['studio', 'wall', 'home'], links: ['studio', 'wall'] } as const;
/** A configuration that is longer than this, as JSON, is refused (the schema makes a real one a few hundred bytes). */
export const UI_PREFS_MAX_BYTES = 4096;

export type SectionId = (typeof SECTION_IDS)[number];
export type DockId = (typeof DOCKS)[number];
export type InboxView = (typeof VIEWS.inbox)[number];
export type LinksView = (typeof VIEWS.links)[number];

export interface SectionPref {
  id: SectionId;
  visible: boolean;
}

/** The complete configuration, as the server answers it. */
export interface UiPrefs {
  v: 1;
  views: { inbox: InboxView; links: LinksView };
  home: { sections: SectionPref[] };
  /** `float` is the place of the floating Player as a fraction (0..1) of the free area; (1, 1) is the bottom-right corner. */
  player: { dock: DockId; float: { x: number; y: number } };
}

/** What a client sends, and what is kept in the database: only the parts that are named. */
export interface UiPrefsPatch {
  v?: 1;
  views?: Partial<UiPrefs['views']>;
  home?: { sections?: SectionPref[] };
  player?: { dock?: DockId; float?: Partial<UiPrefs['player']['float']> };
}

export type ParseUiPrefsResult = { ok: true; patch: UiPrefsPatch } | { ok: false; error: string };

const SECTION_SET: ReadonlySet<string> = new Set(SECTION_IDS);
const DOCK_SET: ReadonlySet<string> = new Set(DOCKS);
const TOP_KEYS: ReadonlySet<string> = new Set(['v', 'views', 'home', 'player']);
const AXES = ['x', 'y'] as const;

const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (key: string): ParseUiPrefsResult => ({ ok: false, error: `invalid_prefs:${key}` });

/** What a user gets before choosing anything: Studio (the A view) everywhere, the five sections visible in order, the Player at the bottom. */
export function defaultUiPrefs(): UiPrefs {
  return {
    v: 1,
    views: { inbox: 'studio', links: 'studio' },
    home: { sections: SECTION_IDS.map((id) => ({ id, visible: true })) },
    player: { dock: 'bottom', float: { x: 1, y: 1 } },
  };
}

const validView = (page: keyof typeof VIEWS, value: unknown): boolean => typeof value === 'string' && (VIEWS[page] as readonly string[]).includes(value);
const validDock = (value: unknown): value is DockId => typeof value === 'string' && DOCK_SET.has(value);
const validAxis = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** The list of sections: exactly the five ids, each once, each with a boolean. Answers the list, or the name of the key that is wrong. */
function checkSections(value: unknown): SectionPref[] | string {
  if (!Array.isArray(value) || value.length !== SECTION_IDS.length) return 'home.sections';
  const seen = new Set<string>();
  const out: SectionPref[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (!isPlain(item)) return `home.sections.${i}`;
    for (const key of Object.keys(item)) if (key !== 'id' && key !== 'visible') return `home.sections.${i}.${key}`;
    if (typeof item.id !== 'string' || !SECTION_SET.has(item.id) || seen.has(item.id)) return `home.sections.${i}.id`;
    if (typeof item.visible !== 'boolean') return `home.sections.${i}.visible`;
    seen.add(item.id);
    out.push({ id: item.id as SectionId, visible: item.visible });
  }
  return out;
}

/**
 * Checks what a client sent against the closed schema. The answer is a COPY holding only known keys; an error names the key
 * (`invalid_prefs:player.float.x`). Order: the body, its size, the unknown keys (in the order they came), then each known part.
 */
export function parseUiPrefsPatch(raw: unknown): ParseUiPrefsResult {
  if (!isPlain(raw)) return fail('body');
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    return fail('body');
  }
  if (bytes > UI_PREFS_MAX_BYTES) return fail('size');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) return fail(key);

  const patch: UiPrefsPatch = {};
  if (raw.v !== undefined) {
    if (raw.v !== 1) return fail('v');
    patch.v = 1;
  }

  if (raw.views !== undefined) {
    if (!isPlain(raw.views)) return fail('views');
    for (const page of Object.keys(raw.views)) if (!has(VIEWS, page)) return fail(`views.${page}`);
    const views: NonNullable<UiPrefsPatch['views']> = {};
    for (const page of Object.keys(VIEWS) as Array<keyof typeof VIEWS>) {
      const value = raw.views[page];
      if (value === undefined) continue;
      if (!validView(page, value)) return fail(`views.${page}`);
      (views as Record<string, string>)[page] = value as string;
    }
    patch.views = views;
  }

  if (raw.home !== undefined) {
    if (!isPlain(raw.home)) return fail('home');
    for (const key of Object.keys(raw.home)) if (key !== 'sections') return fail(`home.${key}`);
    const home: NonNullable<UiPrefsPatch['home']> = {};
    if (raw.home.sections !== undefined) {
      const sections = checkSections(raw.home.sections);
      if (typeof sections === 'string') return fail(sections);
      home.sections = sections;
    }
    patch.home = home;
  }

  if (raw.player !== undefined) {
    if (!isPlain(raw.player)) return fail('player');
    for (const key of Object.keys(raw.player)) if (key !== 'dock' && key !== 'float') return fail(`player.${key}`);
    const player: NonNullable<UiPrefsPatch['player']> = {};
    if (raw.player.dock !== undefined) {
      if (!validDock(raw.player.dock)) return fail('player.dock');
      player.dock = raw.player.dock;
    }
    if (raw.player.float !== undefined) {
      if (!isPlain(raw.player.float)) return fail('player.float');
      for (const key of Object.keys(raw.player.float)) if (key !== 'x' && key !== 'y') return fail(`player.float.${key}`);
      const float: NonNullable<NonNullable<UiPrefsPatch['player']>['float']> = {};
      for (const axis of AXES) {
        const value = raw.player.float[axis];
        if (value === undefined) continue;
        if (!validAxis(value)) return fail(`player.float.${axis}`);
        float[axis] = value;
      }
      player.float = float;
    }
    patch.player = player;
  }
  return { ok: true, patch };
}

/** A patch over a complete document: the views merge page by page, the sections are replaced whole, the dock is replaced, the position merges by axis. */
export function mergeUiPrefs(base: UiPrefs, patch: UiPrefsPatch): UiPrefs {
  const views = { ...base.views };
  for (const page of Object.keys(VIEWS) as Array<keyof typeof VIEWS>) {
    const value = patch.views?.[page];
    if (value !== undefined) (views as Record<string, string>)[page] = value;
  }
  const float = { ...base.player.float };
  for (const axis of AXES) {
    const value = patch.player?.float?.[axis];
    if (value !== undefined) float[axis] = value;
  }
  return {
    v: 1,
    views,
    home: { sections: (patch.home?.sections ?? base.home.sections).map((s) => ({ id: s.id, visible: s.visible })) },
    player: { dock: patch.player?.dock ?? base.player.dock, float },
  };
}

/** Two patches into one, the later winning: this is how what the user CHOSE is kept, sparse, in the database. Empty parts are left out. */
export function mergeUiPrefsPatches(a: UiPrefsPatch, b: UiPrefsPatch): UiPrefsPatch {
  const out: UiPrefsPatch = {};
  const views: Record<string, string> = { ...(a.views as Record<string, string> | undefined) };
  for (const [page, value] of Object.entries(b.views ?? {})) if (value !== undefined) views[page] = value;
  if (Object.keys(views).length > 0) out.views = views as UiPrefsPatch['views'];

  const sections = b.home?.sections ?? a.home?.sections;
  if (sections) out.home = { sections: sections.map((s) => ({ id: s.id, visible: s.visible })) };

  const player: NonNullable<UiPrefsPatch['player']> = {};
  const dock = b.player?.dock ?? a.player?.dock;
  if (dock !== undefined) player.dock = dock;
  const float: Partial<UiPrefs['player']['float']> = {};
  for (const axis of AXES) {
    const value = b.player?.float?.[axis] ?? a.player?.float?.[axis];
    if (value !== undefined) float[axis] = value;
  }
  if (Object.keys(float).length > 0) player.float = float;
  if (Object.keys(player).length > 0) out.player = player;
  return out;
}

/**
 * What the database holds may be old or damaged: keep, key by key, what is still valid, and drop the rest without a word. A list of
 * sections that is no longer exactly the five ids is dropped whole.
 */
export function sanitizeStoredUiPrefs(stored: unknown): UiPrefsPatch {
  const out: UiPrefsPatch = {};
  if (!isPlain(stored)) return out;

  if (isPlain(stored.views)) {
    const views: Record<string, string> = {};
    for (const page of Object.keys(VIEWS) as Array<keyof typeof VIEWS>) {
      const value = stored.views[page];
      if (validView(page, value)) views[page] = value as string;
    }
    if (Object.keys(views).length > 0) out.views = views as UiPrefsPatch['views'];
  }

  if (isPlain(stored.home)) {
    const sections = checkSections(stored.home.sections);
    if (typeof sections !== 'string') out.home = { sections };
  }

  if (isPlain(stored.player)) {
    const player: NonNullable<UiPrefsPatch['player']> = {};
    if (validDock(stored.player.dock)) player.dock = stored.player.dock;
    if (isPlain(stored.player.float)) {
      const float: Partial<UiPrefs['player']['float']> = {};
      for (const axis of AXES) {
        const value = stored.player.float[axis];
        if (validAxis(value)) float[axis] = value;
      }
      if (Object.keys(float).length > 0) player.float = float;
    }
    if (Object.keys(player).length > 0) out.player = player;
  }
  return out;
}

/** The complete configuration of a user: what he chose, over the defaults. A user who never chose anything gets the defaults. */
export async function getUiPrefs(userId: string): Promise<UiPrefs> {
  const rows = await query<{ prefs: unknown }>('SELECT prefs FROM user_prefs WHERE user_id = $1', [userId]);
  return mergeUiPrefs(defaultUiPrefs(), sanitizeStoredUiPrefs(rows[0]?.prefs));
}

/**
 * Saves a patch that `parseUiPrefsPatch` already accepted: merged into what the user chose before, kept sparse; answers the COMPLETE document.
 * Two saves of the same user (two devices) are serialised by an advisory lock held for the transaction, so neither erases the other.
 */
export async function saveUiPrefs(userId: string, patch: UiPrefsPatch): Promise<UiPrefs> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('user_prefs'), hashtext($1))", [userId]);
      const stored = await client.query<{ prefs: unknown }>('SELECT prefs FROM user_prefs WHERE user_id = $1', [userId]);
      const chosen = mergeUiPrefsPatches(sanitizeStoredUiPrefs(stored.rows[0]?.prefs), patch);
      await client.query(
        `INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
        [userId, JSON.stringify(chosen)],
      );
      await client.query('COMMIT');
      return mergeUiPrefs(defaultUiPrefs(), chosen);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

/** Back to the defaults: the user's choices are taken away. */
export async function resetUiPrefs(userId: string): Promise<UiPrefs> {
  await query('DELETE FROM user_prefs WHERE user_id = $1', [userId]);
  return defaultUiPrefs();
}
