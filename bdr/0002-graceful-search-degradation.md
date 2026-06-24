# BDR-0002: Graceful Search Degradation on Ollama Timeout

## Status
Accepted

## Date
2026-06-23

## Owners
Michele Mondora

## Related
- `backend/src/services/queryExpander.ts`
- `backend/src/routes/search.ts`
- ADR-0001: Postgres FTS over pgvector for search
- ADR-0003: Reuse qwen2.5:3b for query expansion
- BDR-0001: No real external calls in tests

---

## 1. Context
SoundReel's search feature uses Ollama `qwen2.5:3b` to expand search queries with synonyms before hitting Postgres FTS (see ADR-0001, ADR-0003). Ollama runs on the GEEKOM A8 Max alongside other workloads: the content analysis pipeline (video processing, AI caption analysis), the Whisper transcription service, and the OCR container. Under concurrent load, Ollama response times can spike. Additionally, Ollama may be temporarily unavailable due to GPU memory pressure, system restarts, or maintenance. Search is a user-facing feature that must remain responsive at all times — including when Ollama is struggling.

## 2. Decision
Enforce a hard 5-second timeout on Ollama query expansion via `Promise.race`. If expansion times out or errors, search proceeds with the original user keywords only. The user sees "Cercato anche: ..." (expanded terms) only when expansion succeeds.

## 3. Drivers
- GEEKOM A8 Max is a personal machine running multiple concurrent AI workloads
- Search must be available even during heavy content ingestion (video analysis consumes most VRAM)
- A 5-second search wait is the upper limit for acceptable UX on a personal tool
- Keyword-only FTS is still useful — it catches exact matches and close variants

## 4. Options Considered

### Option A: 5s timeout + graceful fallback to keyword-only search (chosen)
- **Pros**: search always returns results; degraded experience is still functional; timeout is visible in logs for monitoring; user-facing only when expansion succeeds (no confusing empty-state from timeout)
- **Cons**: during Ollama contention, users see keyword-only results without explanation; timeout value (5s) is a heuristic that may need tuning
- **Product impact**: search always works; synonym quality improves when Ollama is available

### Option B: Fail search if Ollama is unavailable
- **Pros**: consistent experience (always synonym-expanded or always fails); cleaner error handling
- **Cons**: search completely unavailable during GPU-intensive content analysis — directly contradicts product goal; poor UX for a feature that should be always-on
- **Product impact**: search outage correlated with most active usage periods (when user is adding content)

### Option C: No Ollama expansion (keyword-only always)
- **Pros**: zero dependency on Ollama availability; simplest implementation; deterministic results
- **Cons**: misses cross-language synonyms; "sad music" won't find "musica malinconica"; reduces the value of the search feature significantly
- **Product impact**: acceptable baseline but misses the key use case (memory-based discovery across languages)

## 5. Decision Rationale
The key product insight: the value of synonym expansion is additive — it makes good results great, but keyword search is still useful without it. Blocking search on Ollama availability would mean the feature is least available exactly when the user is most active on the app (adding new content). Option A provides the best product experience: search always works, and when Ollama responds within 5 seconds, the experience is richer. The 5-second threshold was chosen as the maximum acceptable wait before the user perceives the search as broken; in practice, `qwen2.5:3b` responds in 1–3 seconds under normal load.

## 6. Consequences

### Positive
- Search feature has 100% availability regardless of Ollama state
- Users can always find content by exact or close-match keywords
- Expansion adds value without being a dependency — positive surprise when it works
- Timeout prevents cascading slowness from Ollama into search UX

### Negative
- During Ollama contention, cross-language and synonym-based search degrades silently — user may not understand why "sad" didn't find "malinconia" entries
- No user-facing indication that expansion is unavailable (by design — avoids confusing UI state)
- 5s timeout may be too generous under extreme GPU pressure, making search feel slow

### Follow-ups
- Add server-side logging of expansion timeout events to detect patterns of Ollama unavailability
- Consider surfacing a subtle indicator in the frontend when expansion was skipped (future: "Basic search mode")
- Monitor p95 of Ollama expansion response time over 30 days; tune timeout if needed

## 7. Guardrails
- `queryExpander.ts` must never throw — errors and timeouts return `[]`
- `search.ts` must handle `[]` expansion array by constructing query from user input only
- Search endpoint response time SLO: p95 < 500ms (Postgres FTS alone) regardless of Ollama state
- Log every timeout as `WARN` level with elapsed time for monitoring

## 8. Migration Plan
Already implemented. `queryExpander.ts` wraps the Ollama call in `Promise.race` with a 5-second rejection. The search route checks if the expansion array is empty before constructing synonym OR-clauses.

## 9. Rollback
**Trigger**: timeout threshold proves wrong (too short: expansions are cut off mid-generation; too long: users wait 5s before seeing degraded results).

**Steps to tune timeout**:
1. Check Ollama response time logs (WARN entries from expansion timeouts)
2. Update `EXPANSION_TIMEOUT_MS` constant in `queryExpander.ts`
3. Redeploy — no migration required

**Steps to disable expansion entirely**:
1. Set `queryExpander.ts` to always return `[]`
2. Search reverts to keyword-only — no other changes needed
3. Re-enable when Ollama availability improves
