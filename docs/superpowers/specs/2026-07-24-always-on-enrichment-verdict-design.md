# Always-On Enrichment Verdict During Analysis Design

**Date:** 2026-07-24
**Status:** Approved
**Scope:** Make the context-classification + verdict tag (from ADR-0004 / the "Arricchisci" feature) run automatically as part of every analysis, instead of requiring a manual click or an opt-in feature flag. Remove the now-redundant `autoEnrichEnabled` toggle.

---

## Problem

The context-aware enrichment shipped earlier today (ADR-0004) computes a `category` + optional `verdict` (vero/falso/dubbio/ai-generated/phishing/sicuro/sospetto + confidence + explanation) for each entry, but it only runs when:

1. The user manually clicks "Arricchisci" on an already-completed entry, or
2. The `autoEnrichEnabled` feature flag is on — which defaults to `false` and requires a trip to Settings to enable.

The user wants the fake/AI/true signal computed **immediately, as part of analysis** — not as an opt-in afterthought requiring a manual step.

## Goal

Every analyzed entry gets its `category`/`verdict` computed automatically, with no flag to configure. The only remaining precondition is that OpenAI is configured and enabled in Settings (`openaiConfig.enabled && openaiConfig.apiKey`) — the same precondition that already gates the OpenAI-based enrichment call today, orthogonal to the flag being removed.

## Approach

**Un-gate the existing code path; delete the flag.** The auto-enrich block in `analyze.ts` already does exactly the right thing — it runs after the entry is marked `completed`, calls `enrichWithOpenAI`, persists the result, and fails soft (logged, non-blocking) if anything goes wrong. The only change needed is removing the `if (featuresConfig.autoEnrichEnabled)` condition wrapping it. No new code path, no new service, no new tests for the enrichment logic itself (already covered by `openaiEnrich.test.ts` and `entries.test.ts` from ADR-0004).

Rejected alternative: **flip the flag's default to `true`, keep it togglable.** Rejected per explicit decision — a flag that always defaults on but can still be turned off is confusing dead weight for a feature that's no longer optional. Removing it entirely is simpler and matches YAGNI.

Rejected alternative: **block entry completion until the verdict is ready** (single atomic completion). Rejected per explicit decision — the current fire-after-completion timing (entry becomes visible immediately, verdict arrives via a follow-up SSE update moments later) is kept as-is; blocking would add OpenAI web-search latency to every analysis and risk the 120s pipeline timeout for no clear benefit.

## Changes

### Backend

**`backend/src/routes/analyze.ts`** — remove the `if (featuresConfig.autoEnrichEnabled) { ... }` wrapper around the existing enrichment block (lines ~743-763 as of ADR-0004's merge). The inner logic (`openaiConfig.enabled && openaiConfig.apiKey` check, `enrichWithOpenAI` call, `updateEntry`, `appendActionLog('auto_enriched'/'auto_enrich_failed')`) is unchanged — just no longer conditional on the flag.

**`backend/src/utils/db.ts`** — remove `autoEnrichEnabled: boolean` from the `FeaturesConfig` interface and `autoEnrichEnabled: false` from `DEFAULT_FEATURES`.

No route changes needed in `backend/src/routes/config.ts` — it reads/writes `FeaturesConfig` generically; removing the field from the type is sufficient.

### Frontend

- `frontend/src/types/index.ts` and `frontend/src/services/api.ts` — remove `autoEnrichEnabled: boolean` from both `FeaturesConfig` type definitions.
- `frontend/src/pages/Settings.tsx` — remove the `autoEnrichEnabled: false` default fallback, the `handleToggleAutoEnrich` handler, and the toggle UI block (`.feature-toggle` div rendering `t.autoEnrich`/`t.autoEnrichDescription`).
- `frontend/src/i18n/translations.ts` — remove `autoEnrich`/`autoEnrichDescription` keys (declaration + IT + EN values).

### Not changed
- `openaiEnrich.ts`, `promptLoader.ts`, `entries.ts` (`POST /api/entries/enrich`), `EntryInspector.tsx`, `EntryCard.tsx` — all already correct from ADR-0004, untouched.
- The OpenAI Settings section (`openaiSection`/`openaiDescription`, API key + enabled toggle) stays exactly as-is — it remains the real precondition for enrichment running at all.

## Error Handling
Unchanged from ADR-0004: OpenAI failure, missing API key, or malformed response all degrade to a logged `actionLog` entry (`auto_enrich_failed`) without blocking or failing the analysis. This was already true before removing the flag; removing the flag only changes *whether* the block is entered, not its internal resilience.

## Testing
No new automated tests — the enrichment logic itself is already covered by `openaiEnrich.test.ts` (11 tests) and `entries.test.ts` (4 tests) from ADR-0004. This change removes a conditional with no branch-specific logic of its own, so there is nothing new to unit test. Verification is: backend typecheck + full test suite pass after the flag's removal (confirms no other code references the deleted field), plus a manual read-through of `analyze.ts` to confirm the un-gated block's structure is unchanged.
