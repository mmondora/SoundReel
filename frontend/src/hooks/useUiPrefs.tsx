import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { UiPrefsAnonymousError, fetchUiPrefs, resetUiPrefs, saveUiPrefs } from '../services/api';
import { applyPrefsPatch, readCachedPrefs, writeCachedPrefs } from '../utils/uiPrefs';
import type { UiPrefs, UiPrefsPatch } from '../types';

// ADR-0026, docs/ui-prefs.md: the configuration of the user lives on the server, which decides every default and validates every change.
// The provider reads it once, draws the copy of the session while the answer is on its way, applies a change at once (the same merge the
// server does) and puts it back, with a message, if the server refuses. Nothing is decided here: a page with no document is the Studio,
// the layout every page had before the views existed.

export interface UiPrefsApi {
  /** The document to draw: what the server answered (or the copy of the session until it does), with the changes still on their way. */
  prefs: UiPrefs | null;
  /** The first answer of the server has not come yet. */
  loading: boolean;
  /** The last change the server refused (its message), until dismissed; null otherwise. */
  saveError: string | null;
  clearSaveError: () => void;
  /** Only the parts to change. Resolves when the server has answered; a refusal is `saveError`, never a rejection. */
  update: (patch: UiPrefsPatch) => Promise<void>;
  /** Back to the starting values (the choices of the user are forgotten on the server). */
  reset: () => Promise<void>;
}

/** Outside a provider (a page rendered alone): no document, nothing loading, changes ignored: the page draws the Studio. */
const OUTSIDE: UiPrefsApi = {
  prefs: null,
  loading: false,
  saveError: null,
  clearSaveError: () => undefined,
  update: async () => undefined,
  reset: async () => undefined,
};

const UiPrefsContext = createContext<UiPrefsApi>(OUTSIDE);

interface Pending {
  seq: number;
  patch: UiPrefsPatch;
}

/** What the provider remembers between renders; every change goes through `commit()` so that React draws again. */
interface Store {
  /** The last document of the server (or the copy of the session before it answers). */
  confirmed: UiPrefs | null;
  /** The changes sent and not yet answered, drawn on top of `confirmed`. */
  pending: Pending[];
  /** Every request gets a number when it is made; an answer older than the last one applied is ignored (it would undo a newer choice). */
  nextSeq: number;
  lastApplied: number;
  /** The writes go to the server one at a time, in the order they were made: the end of the last one. It never rejects. */
  queue: Promise<void>;
  /** How many writes are running or waiting (the first one of an idle queue starts at once). */
  jobs: number;
  /** The server said 401: no user. Changes live in this visit only. */
  anonymous: boolean;
  loading: boolean;
  saveError: string | null;
}

const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Store | null>(null);
  if (ref.current === null) {
    ref.current = { confirmed: readCachedPrefs(), pending: [], nextSeq: 0, lastApplied: -1, queue: Promise.resolve(), jobs: 0, anonymous: false, loading: true, saveError: null };
  }
  const store = ref.current;
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  /** An answer of the server: it is the truth unless a newer one was already applied; the changes still waiting stay drawn on top of it. */
  const accept = useCallback((seq: number, doc: UiPrefs): void => {
    if (seq <= store.lastApplied) return;
    store.lastApplied = seq;
    store.confirmed = doc;
    writeCachedPrefs(doc);
  }, [store]);

  /** Runs a write after the ones made before it (at once when there is none). `job` handles its own errors. */
  const enqueue = useCallback((job: () => Promise<void>): Promise<void> => {
    const run = store.jobs === 0 ? job() : store.queue.then(job);
    store.jobs += 1;
    store.queue = run.finally(() => { store.jobs -= 1; });
    return store.queue;
  }, [store]);

  useEffect(() => {
    let alive = true;
    const seq = store.nextSeq++;
    fetchUiPrefs()
      .then((doc) => { if (alive) accept(seq, doc); })
      .catch(() => { /* no answer: the copy of the session (if any) stays, else the page draws the Studio */ })
      .finally(() => {
        if (!alive) return;
        store.loading = false;
        redraw();
      });
    return () => { alive = false; };
  }, [store, accept]);

  /** The change is drawn at once; it is sent when the ones before it are done. */
  const update = useCallback((patch: UiPrefsPatch): Promise<void> => {
    const seq = store.nextSeq++;
    store.pending = [...store.pending, { seq, patch }];
    redraw();
    return enqueue(async () => {
      try {
        if (store.anonymous) throw new UiPrefsAnonymousError();       // a write before this one found out there is no user
        accept(seq, await saveUiPrefs(patch));
      } catch (err) {
        if (err instanceof UiPrefsAnonymousError) {
          store.anonymous = true;
          if (store.confirmed) store.confirmed = applyPrefsPatch(store.confirmed, patch);
        } else {
          store.saveError = messageOf(err);
        }
      } finally {
        store.pending = store.pending.filter((p) => p.seq !== seq);    // the answer (or the refusal) replaces the drawn change
      }
      redraw();
    });
  }, [store, enqueue, accept]);

  const reset = useCallback((): Promise<void> => {
    const seq = store.nextSeq++;
    return enqueue(async () => {
      try {
        if (store.anonymous) return;
        accept(seq, await resetUiPrefs());
      } catch (err) {
        if (err instanceof UiPrefsAnonymousError) store.anonymous = true;
        else store.saveError = messageOf(err);
      }
      redraw();
    });
  }, [store, enqueue, accept]);

  const clearSaveError = useCallback(() => {
    store.saveError = null;
    redraw();
  }, [store]);

  // `redraw` is the only thing that changes between renders, so the snapshot is read from the store on every render.
  const prefs = store.confirmed && store.pending.reduce((doc, p) => applyPrefsPatch(doc, p.patch), store.confirmed);
  const value: UiPrefsApi = {
    prefs,
    loading: store.loading,
    saveError: store.saveError,
    clearSaveError,
    update,
    reset,
  };
  return <UiPrefsContext.Provider value={value}>{children}</UiPrefsContext.Provider>;
}

export function useUiPrefs(): UiPrefsApi {
  return useContext(UiPrefsContext);
}

export type PageWithViews = keyof UiPrefs['views'];

/** The views each page has, in the order the switch shows them (the Link page has no Home). A view this build does not know is the Studio. */
export const PAGE_VIEWS: { [P in PageWithViews]: ReadonlyArray<UiPrefs['views'][P]> } = {
  inbox: ['home', 'studio', 'wall'],
  links: ['studio', 'wall'],
};

export interface PageView<P extends PageWithViews> {
  /** What to draw. */
  view: UiPrefs['views'][P];
  /** False only while the first answer of the server is on its way and there is no copy to draw: the page waits instead of flashing a wrong view. */
  ready: boolean;
  /** Choosing a view draws it at once and saves it (only this page) on the server. */
  setView: (view: UiPrefs['views'][P]) => void;
}

export function usePageView<P extends PageWithViews>(page: P): PageView<P> {
  const { prefs, loading, update } = useUiPrefs();
  const saved: string | undefined = prefs?.views[page];
  const view = (saved !== undefined && (PAGE_VIEWS[page] as readonly string[]).includes(saved) ? saved : 'studio') as UiPrefs['views'][P];
  const setView = useCallback((next: UiPrefs['views'][P]) => {
    void update({ views: { [page]: next } } as UiPrefsPatch);
  }, [update, page]);
  return useMemo(() => ({ view, ready: prefs !== null || !loading, setView }), [view, prefs, loading, setView]);
}
