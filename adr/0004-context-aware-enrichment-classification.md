# ADR-0004: Single-Call Self-Classifying Enrichment (context-aware "Arricchisci")

## Status
Accepted (late ADR — see § 1)

## Date
2026-07-24

## Owners
Michele Mondora

## Related
- `docs/superpowers/specs/2026-07-24-context-enrichment-design.md`
- `docs/superpowers/plans/2026-07-24-context-enrichment.md`
- `backend/src/services/openaiEnrich.ts`
- `backend/src/services/promptLoader.ts` (template id `enrichment`)
- `backend/src/routes/entries.ts` (`POST /api/entries/enrich`)
- `frontend/src/components/EntryInspector.tsx`, `frontend/src/components/EntryCard.tsx`

---

## 1. Context
The generic "Deep Search" enrichment (OpenAI Responses API + `web_search_preview`) treated every entry identically: it searched for "useful links" per extracted song/film/note, with no awareness of what kind of content it was looking at. Two problems motivated a redesign:

1. **Broken trigger**: the frontend's manual enrichment button called `POST /api/entries/enrich`, which had no backend route — a pure bug, unrelated to the classification question, fixed alongside this change.
2. **No context awareness**: a GitHub repo link, a suspicious/phishing domain, and a viral/implausible news claim (e.g. "Massive doorway discovered in Kentucky") all got the same generic "find links" treatment, with no tailored explanation and no truth/safety signal.

This is a **late ADR**: the brainstorming → design spec → implementation → merge → deploy cycle ran in a single session (see the linked spec and plan, both dated the same day) before this ADR was written. The decision below reflects what was actually decided during brainstorming, recorded after the fact for future reference.

## 2. Decision
Classify entry content into one of four categories (`tech`, `security`, `claim`, `generic`) and produce category-tailored output — including a `verdict` (label + confidence + explanation) for `security`/`claim` — using a **single OpenAI Responses API call** with one self-classifying prompt, rather than a separate classification step.

## 3. Drivers
- Personal, single-user app — operational simplicity and low cost matter more than maximum classification accuracy.
- Existing infra: one OpenAI call (`gpt-4o-mini` + `web_search_preview`) already in place; reusing it avoids new integration surface.
- The prompt template system (`promptLoader.ts`, `/api/prompts`) already supports free-form editable Handlebars templates — no schema change needed to support richer instructions.

## 4. Options Considered

### Option A: Single LLM call, self-classifying prompt (chosen)
- **Pros**: zero additional latency/cost versus the call already being made; one prompt to maintain (edited in-place via the existing Prompts settings page); classification and content generation share the same web-search context, so the model doesn't have to re-derive what it already found
- **Cons**: classification accuracy is coupled to how well the prompt is worded — no independent measurement of classification correctness apart from output quality; a single malformed JSON response loses both the classification and the content
- **Cost impact**: zero — same single `gpt-4o-mini` call as before, only the prompt text and parsed shape changed

### Option B: Rule-based pre-classification (regex/domain-list) + category-specific prompt
- **Pros**: deterministic, inspectable classification logic; easy to unit test in isolation
- **Cons**: doubles the number of prompt templates to maintain (one per category); rule set inevitably lags real-world URL/content variety (new domains, novel claim phrasing); adds backend classification code with its own maintenance burden
- **Cost impact**: zero infra cost, but ongoing engineering maintenance cost as URL/domain patterns evolve

### Option C: Two-stage LLM (cheap classification call, then tailored call)
- **Pros**: potentially more accurate classification, since the first call is singly focused on category detection
- **Cons**: doubles per-enrichment latency and OpenAI cost; for a personal app triggered manually per entry, the accuracy gain wasn't judged worth 2x cost
- **Cost impact**: ~2x OpenAI spend per enrichment call (still small in absolute terms, but disproportionate to the benefit for this app's usage volume)

## 5. Decision Rationale
Option A wins on the same "minimal footprint for a personal app" principle as ADR-0003: no new infrastructure, no new maintenance surface, and the existing prompt-editing UI (`/api/prompts`) remains the single point of control. The risk accepted is that classification quality lives entirely in prompt wording rather than in testable code — mitigated by keeping parsing/validation strict in `openaiEnrich.ts` (invalid category defaults to `generic`, invalid verdict is dropped, malformed JSON falls back to `{category: 'generic', items: []}` with a logged warning) so a bad classification degrades to today's generic behavior rather than producing garbage.

## 6. Consequences

### Positive
- Manual enrichment works for the first time (route bug fixed as part of this change)
- One prompt template to edit/tune going forward, visible and editable without a deploy (`/api/prompts`)
- `security`/`claim` categories now surface an explicit verdict badge (vero/falso/dubbio/ai-generated/phishing/sicuro/sospetto + confidence + explanation) instead of presenting unverified claims as flat fact
- `EnrichmentResult` shape (`category`, optional `verdict`, `items[]` with per-item `explanation`) is a strict superset of information versus the old `EnrichmentItem[]`

### Negative
- **Breaking storage shape change**: `EntryResults.enrichments` changed from `EnrichmentItem[]` to `EnrichmentResult` (an object). Accepted as low-risk because the manual trigger was 404ing (never produced stored data) and `autoEnrichEnabled` defaults to `false` — no meaningful existing production data depended on the old shape. No migration script was written.
- Classification errors are only observable through output quality, not through a dedicated classification metric or test
- A single JSON parse failure loses the entire result (classification + items + verdict) for that call, falling back to `generic`/empty rather than partially recovering

### Follow-ups
- If classification quality proves poor in practice (e.g. `tech` content misclassified as `generic`), consider Option B for the specific categories that need deterministic detection (e.g. `github.com` domain match forcing `tech`) as a narrow hybrid, without abandoning the single-call approach entirely.
- No dedicated eval/test harness exists for classification accuracy — this is a known gap for a feature whose entire value proposition is "correctly identify content type."

## 7. Guardrails
- `backend/src/services/openaiEnrich.test.ts`: unit tests (mocked `fetch`, no real OpenAI calls per project testing conventions) cover one case per category, verdict clamping (`confidence` bounded 0–100), verdict dropped for `tech`/`generic`, malformed-JSON fallback, and link/item filtering — 11 tests, all passing at merge time.
- `backend/src/routes/entries.test.ts`: route-level tests cover success, missing-entry 404, and non-throwing service-failure path (`manual_enrich_failed` logged to `actionLog`).
- Every failure path (OpenAI error, JSON parse failure, missing API key) is caught and logged — never crashes the request, per CLAUDE.md's pipeline resilience convention.

## 8. Migration Plan
No data migration — see § 6 Negative. Already implemented and deployed:
1. Types updated (`backend/src/types/index.ts`, `frontend/src/types/index.ts`)
2. Prompt template rewritten (`promptLoader.ts`, `enrichment` id)
3. `openaiEnrich.ts` rewritten to parse the new object shape
4. `POST /api/entries/enrich` route registered (previously missing)
5. `analyze.ts` auto-enrich call site updated to the new shape
6. Frontend (`EntryInspector.tsx`, `EntryCard.tsx`, `api.ts`, i18n) updated to render `category`/`verdict`/`items[].explanation`
7. Merged to `main` (commit `f0d59e2`), pushed, deployed via `.rebuild` sentinel — container `soundreel` confirmed healthy post-deploy (2026-07-24)

## 9. Rollback
**Trigger**: classification is consistently wrong (e.g. `tech` links routinely misclassified as `generic`, or `claim` verdicts are unreliable enough to be misleading rather than helpful).

**Steps**:
1. Revert the `enrichment` prompt template to the pre-classification version via `/api/prompts` (no deploy needed — templates are stored in Postgres, not code) to immediately stop producing verdicts while keeping the rest of the pipeline intact.
2. If the object shape itself needs reverting, revert the linked commits (types, `openaiEnrich.ts`, route, frontend) — no stored data migration needed since no meaningful old-shape data exists in production (see § 6).

**Estimated effort**: minutes for the prompt-only rollback (Step 1); under an hour for a full code revert (Step 2), since all changes are captured in reviewable, independently-tested commits.
