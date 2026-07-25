# Verdict Visibility (Icons + Bold Tag) and Category/Verdict Filters Design

**Date:** 2026-07-25
**Status:** Approved
**Scope:** Surface the enrichment verdict (fake/AI/true/phishing/etc, from ADR-0004) prominently in the UI — as a bold first tag and as a colored icon — and add category/verdict filter chips to the main feed.

---

## Problem

The verdict badge added in ADR-0004 only appears inside the "Enrichments" section, which is buried below songs/films/notes/links/tags in the entry detail panel (`EntryInspector`), and doesn't appear at all in the main feed list. The user has to open every entry and scroll down to see whether something was flagged as fake/AI-generated/phishing. There's also no way to filter the feed by category (tech/security/claim) or verdict (vero/falso/phishing/etc) to quickly find flagged entries.

## Investigation Finding

`EntryCard.tsx` (used by `Journal.tsx`) is **dead code** — neither component is rendered anywhere in the live app. The actual live surfaces are:
- `frontend/src/components/CompactCard.tsx`, rendered by `frontend/src/pages/Home.tsx` — the main feed list (click-to-select, no action buttons)
- `frontend/src/components/EntryInspector.tsx`, rendered in `Home.tsx`'s detail panel when an entry is selected — has both a tags row and an action-button row
- `frontend/src/pages/EntriesPage.tsx` — a secondary "all entries" list with its own inline rendering, no tags/actions at all (out of scope — no command row and no tags row exist there to attach to; not touched by this change)

This spec targets `CompactCard.tsx`, `EntryInspector.tsx`, `Home.tsx`, and `useJournal.ts`. `EntryCard.tsx`/`Journal.tsx` are left untouched (already compiles from the prior feature; genuinely unreachable code, not part of this change's scope).

## Goal

1. Verdict is visible in the main feed without opening an entry (icon on `CompactCard`).
2. Verdict is visible immediately in the detail view without scrolling to the Enrichments section (bold first tag) and next to the action buttons (icon).
3. The feed can be filtered by category and by verdict, same interaction pattern as the existing platform/channel/user filters.

## Icon Mapping

Extends `frontend/src/utils/enrichmentVerdict.ts` (currently exports `VERDICT_TONE` only).

```ts
export const VERDICT_ICON: Record<EnrichmentVerdictLabel, string> = {
  vero: '✅',
  sicuro: '🛡️',
  dubbio: '❓',
  sospetto: '⚠️',
  falso: '❌',
  'ai-generated': '🤖',
  phishing: '🎣',
};

export const CATEGORY_ICON: Record<EnrichmentCategory, string | null> = {
  tech: '💻',
  security: '🔒',
  claim: '📰',
  generic: null,
};
```

Icons are always rendered with the existing tone color (`VERDICT_TONE` → safe/warning/danger, green/yellow/red) as background/text color, so severity is legible even without reading the label.

## Changes

### `frontend/src/utils/enrichmentVerdict.ts`
Add `VERDICT_ICON` and `CATEGORY_ICON` exports as above (import `EnrichmentCategory` type alongside the existing `EnrichmentVerdictLabel` import).

### `frontend/src/components/CompactCard.tsx`
Next to the existing `.compact-status` dot (line ~101-105), render a verdict icon when `entry.results.enrichments?.verdict` exists: `<span className={`compact-verdict-icon enrichment-verdict-${tone}`}>{VERDICT_ICON[label]}</span>`, title attribute set to the verdict label for hover clarity. No change when no verdict (tech/generic/unenriched entries look exactly as today).

### `frontend/src/components/EntryInspector.tsx`
- **Tags row**: when `entry.results.enrichments?.verdict` exists, render it as the first child of `.inspector-tags`, bold, icon + uppercase label, colored by tone (new class `.inspector-tag-verdict`), before the existing `entry.results.tags.map(...)`.
- **Action row**: add a verdict icon button-like element (non-interactive, `title` = full verdict explanation) inside `.inspector-actions`, positioned first (before retry), so it's the first thing seen next to the command icons.
- Both reuse `VERDICT_ICON`/`VERDICT_TONE` from `enrichmentVerdict.ts` — no new mapping duplicated.

### `frontend/src/hooks/useJournal.ts`
- Extend `JournalFilter` with `category?: string | null` and `verdict?: string | null`.
- Extend `filteredEntries` memo with two more conditions: `if (filterCategory) result = result.filter(e => e.results.enrichments?.category === filterCategory)`; `if (filterVerdict) result = result.filter(e => e.results.enrichments?.verdict?.label === filterVerdict)`.
- Add `availableCategories` and `availableVerdicts` memos (same shape/pattern as `availablePlatforms`), counting from `allEntries`, skipping entries with no `enrichments`/`verdict`.
- Add `filterCategory`/`filterVerdict` to the page-reset `useEffect` dependency array.

### `frontend/src/pages/Home.tsx`
- New state `filterCategory`, `filterVerdict` (same pattern as `filterPlatform`), passed into `useJournal`.
- New `toggleCategory`/`toggleVerdict` callbacks, included in `hasFilter`/`clearFilters`.
- Two new filter-chip groups in `.journal-filter-bar`, after the existing user group, each behind its own `availableCategories.length > 0` / `availableVerdicts.length > 0` guard (don't show an empty divider if nothing to filter by): category chips show `{CATEGORY_ICON[c] ?? ''} {label}` (label from a small `CATEGORY_LABEL` map: tech→"Tech", security→"Sicurezza", claim→"Claim", generic→"Generico"); verdict chips show `{VERDICT_ICON[v]} {v.toUpperCase()}`.

### CSS (`frontend/src/styles/index.css`)
- `.compact-verdict-icon` — small circular/pill icon next to `.compact-status`, sized to match the existing status dot area, colored via the existing `.enrichment-verdict-safe/warning/danger` classes (reused, not duplicated).
- `.inspector-tag-verdict` — bold variant of `.tag-badge`, colored via the same tone classes.
- Action-row verdict icon reuses `.inspector-action-btn` sizing (non-clickable — no hover/disabled states needed, just `title` for the tooltip).

## Error Handling
No new failure modes — this only reads `entry.results.enrichments`, which is already optional (`?.`) everywhere per the existing type. No enrichment/no verdict → nothing renders, exactly like today.

## Testing
No new backend changes — this is a pure frontend read/render/filter change. Verification: frontend typecheck (`tsc -b`) and existing frontend test suite (unaffected — no logic under test changes). No new automated tests added; the existing project convention for these presentational components (`CompactCard`, `EntryInspector`, `Home`) has no component-level tests today (confirmed: only `useSearch.test.ts` exists in frontend), so this follows established precedent rather than introducing new test infrastructure for this change alone.
