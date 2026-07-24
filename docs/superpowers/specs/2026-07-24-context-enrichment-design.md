# Context-Aware Enrichment ("Arricchisci") Design

**Date:** 2026-07-24
**Status:** Approved
**Scope:** Replace the generic "Deep Search" enrichment button with a single context-aware enrichment ("Arricchisci") that auto-classifies entry content (tech/GitHub, security/domain, viral claim, generic) and produces category-appropriate output, including an auto-generated verdict tag (true/false/AI-generated/phishing/etc.) for security and claim-checking categories. Also fixes a pre-existing bug: the manual enrichment endpoint the frontend calls was never registered on the backend.

---

## Problem

The current "Deep Search" feature has two issues:

1. **Broken**: the frontend button (`EntryInspector.tsx`) calls `POST /api/entries/enrich`, but no backend route handler for this path exists anywhere in `backend/src/routes/`. The button 404s. The only code path that actually invokes `enrichWithOpenAI` is the automatic post-analyze enrichment in `analyze.ts`, gated behind `featuresConfig.autoEnrichEnabled` (default `false`).
2. **Context-blind**: even when working, the enrichment prompt treats every entry the same way — it loops over extracted songs/films/notes and searches for generic "useful links" per item. It has no notion of what *kind* of content it's looking at, so it can't give GitHub-specific technical context, security/domain risk signals, or fact-check a viral/implausible claim (e.g. "Massive doorway discovered in Kentucky") with a truth/hallucination verdict.

## Goal

One button, "Arricchisci", that:
1. Works (fixes the missing route).
2. Auto-detects what kind of content the entry is about — tech/GitHub link, security-relevant link/domain, a viral or extraordinary claim worth fact-checking, or the existing generic song/film case — and tailors both the search and the explanation to that category.
3. For security and claim-checking categories, surfaces an explicit verdict tag (e.g. vero/falso/dubbio/ai-generated/phishing/sicuro/sospetto) with a confidence percentage and a plain-language explanation, so a hallucinated or fake claim is visibly flagged rather than presented as fact.

---

## Approach

**Single LLM call, self-classifying prompt.** One rewritten prompt (existing editable template, id `enrichment`) instructs the model to (a) determine the content category itself and (b) return category-appropriate structured JSON in one response, reusing the existing OpenAI Responses API + `web_search_preview` call already in `openaiEnrich.ts`.

Rejected alternative: **rule-based pre-classification** (regex/domain-list in backend code, e.g. `github.com` → tech prompt) then category-specific prompt. More deterministic, but doubles the number of prompts to maintain and adds classification code that will always lag behind real-world URL/content variety (new domains, edge cases). Poor fit for a single-user app where occasional misclassification is low-stakes.

Rejected alternative: **two-stage LLM** (cheap classification call, then a second tailored call). More accurate classification in theory, but doubles cost and latency on every manual enrichment for a marginal accuracy gain the single unified prompt already covers well enough given `web_search_preview` grounding.

---

## Backend

### Route fix (`backend/src/routes/entries.ts`)

Register `POST /api/entries/enrich`:
1. Read `{ entryId }` from body, load entry (404 if missing).
2. Call `enrichWithOpenAI(entry.results, caption)`.
3. Persist result to `entry.results.enrichments` via `updateEntry`.
4. Log actionLog entry: `manual_enrich` on success, `manual_enrich_failed` (with error detail) on failure — failure does not throw, mirrors existing pipeline resilience convention.
5. Return `{ success, enrichment }`.

### Prompt (`enrichment` template, edited via existing `/api/prompts` UI — no schema change to the prompt-editing system itself)

Rewritten to instruct the model to output:

```json
{
  "category": "tech" | "security" | "claim" | "generic",
  "verdict": {
    "label": "vero" | "falso" | "dubbio" | "ai-generated" | "phishing" | "sicuro" | "sospetto",
    "confidence": 0-100,
    "explanation": "..."
  },
  "items": [
    {
      "label": "...",
      "explanation": "...",
      "links": [{ "url": "...", "title": "...", "snippet": "..." }]
    }
  ]
}
```

`verdict` is present only when `category` is `security` or `claim`; omitted for `tech`/`generic`. `items[].explanation` is new — prior schema only had `label` + `links`, no narrative detail.

Category guidance embedded in the prompt:
- **tech**: GitHub/dev-tool links → explain what the repo/project does, activity level, license, notable considerations. No verdict.
- **security**: links/domains with security relevance → domain reputation, phishing/scam signals, age/certificate considerations where determinable via search. Verdict = sicuro/sospetto/phishing.
- **claim**: viral or extraordinary claims/news → fact-check against found sources. Verdict = vero/falso/dubbio/ai-generated.
- **generic**: fallback, same behavior as today (useful links per song/film/note).

### Service (`backend/src/services/openaiEnrich.ts`)

`enrichWithOpenAI` return type changes from `EnrichmentItem[]` to `EnrichmentResult` (see Types). Parsing: extract `output_text`, strip markdown fences, `JSON.parse` the object (not array) at top level, validate `category` is one of the four values and `items` is an array of `{label, links}` (existing per-item validation logic reused). On any parse/validation failure: fall back to `{ category: 'generic', items: [] }` and log the raw parse error to actionLog — same resilience pattern as the rest of the pipeline (§ Resilienza della pipeline, CLAUDE.md).

---

## Types (`backend/src/types/index.ts`, `frontend/src/types/index.ts` — kept in sync as today)

```ts
type EnrichmentVerdictLabel = 'vero' | 'falso' | 'dubbio' | 'ai-generated' | 'phishing' | 'sicuro' | 'sospetto';

interface EnrichmentVerdict {
  label: EnrichmentVerdictLabel;
  confidence: number; // 0-100
  explanation: string;
}

interface EnrichmentItem {
  label: string;
  explanation: string;
  links: EnrichmentLink[]; // unchanged: { url, title, snippet? }
}

interface EnrichmentResult {
  category: 'tech' | 'security' | 'claim' | 'generic';
  verdict?: EnrichmentVerdict;
  items: EnrichmentItem[];
}
```

`EntryResults.enrichments` type changes from `EnrichmentItem[]` to `EnrichmentResult`. This is a breaking shape change to stored JSON, accepted as low-risk: the manual trigger has been 404ing (never produced data) and auto-enrich is off by default, so no meaningful existing data depends on the old shape.

---

## Frontend (`frontend/src/components/EntryInspector.tsx`)

- Button relabeled: "Deep Search" / `runDeepSearch` → **"Arricchisci"** (new i18n keys in `frontend/src/i18n/translations.ts`, IT + EN, replacing `deepSearch`/`runDeepSearch`/`openaiSection`).
- Rendering `entry.results.enrichments` (now `EnrichmentResult`):
  - If `verdict` present: colored badge chip above the items list — green for `vero`/`sicuro`, red for `falso`/`phishing`/`ai-generated`, yellow for `dubbio`/`sospetto` — showing label + `confidence%`, with `explanation` text below it.
  - No badge when `category` is `tech` or `generic`.
  - Each item: `label`, `explanation`, then `links[]` rendered as today (anchor + optional snippet).
- New CSS class `.enrichment-verdict` (colored chip) in `frontend/src/styles/index.css`, alongside existing `.enrichment-item`/`.enrichment-label`/`.enrichment-links` rules.
- `hasEnrichments` check updates from `enrichments?.length > 0` to `!!enrichments` — presence of the result object (not item count) determines whether the results section renders, so a verdict-only response (security/claim category with a verdict but no supporting links) still displays.

---

## Error Handling

Follows existing pipeline resilience convention (CLAUDE.md § Resilienza della pipeline):
- OpenAI call fails → logged to actionLog, button remains clickable for retry, no crash.
- JSON parse/validation fails → falls back to `{ category: 'generic', items: [] }`, raw error logged to actionLog.
- Route-level errors return a clean `{ success: false }` response rather than throwing.

## Testing

- `openaiEnrich.spec.ts`: mocked `fetch` (no real OpenAI calls, per CLAUDE.md testing rules) covering one case per category (`tech`, `security`, `claim`, `generic`), plus malformed-JSON fallback case.
- Route test for `POST /api/entries/enrich`: service mocked, covers success path, missing-entry 404, and service-failure path (non-throwing, actionLog written).
