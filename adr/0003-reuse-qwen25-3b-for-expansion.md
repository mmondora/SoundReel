# ADR-0003: Reuse qwen2.5:3b for Query Expansion

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
- ADR-0002: simple FTS dictionary for mixed IT/EN content
- BDR-0002: Graceful search degradation on Ollama timeout

---

## 1. Context
The Postgres FTS implementation (ADR-0001) relies on query expansion to compensate for the absence of stemming and to provide synonym coverage across Italian and English. Query expansion requires an LLM capable of generating contextually relevant synonyms in both languages. SoundReel already runs Ollama with `qwen2.5:3b` loaded for content analysis (caption parsing, film/song extraction). The question was whether to reuse this model or introduce a new one.

## 2. Decision
Reuse `qwen2.5:3b` (controlled by `OLLAMA_TEXT_MODEL` env var) for synonym/query expansion in `queryExpander.ts`, with a hard 5-second `Promise.race` timeout. No new model is introduced.

## 3. Drivers
- Search feature needed query expansion; Ollama already running
- GEEKOM A8 Max has constrained VRAM shared across workloads
- Adding a new model requires Docker build changes, Ollama pull, and VRAM budget approval
- `qwen2.5:3b` is already warmed in VRAM during active use — expansion calls hit cached weights

## 4. Options Considered

### Option A: Reuse existing `qwen2.5:3b` model (chosen)
- **Pros**: zero additional VRAM; zero new configuration; model already loaded during content analysis sessions; controlled via existing `OLLAMA_TEXT_MODEL` env var so model can be swapped without code changes; 5s timeout prevents blocking search
- **Cons**: model shares VRAM/compute with content analysis pipeline — concurrent heavy analysis + search could slow expansion; model was optimized for extraction, not synonym generation (though it performs adequately in testing)
- **Cost impact**: zero

### Option B: Dedicated embedding model (`nomic-embed-text`, ~275 MB)
- **Pros**: purpose-built for semantic similarity; could also enable pgvector embeddings (ADR-0001 upgrade path); 137M parameters — faster inference than 3B
- **Cons**: requires Ollama pull and persistent VRAM allocation (~275 MB); requires code change to call embedding endpoint instead of completion endpoint; embeddings not directly useful for FTS synonym expansion (different task)
- **Cost impact**: ~275 MB VRAM permanently allocated; Docker image size increase; operational complexity

### Option C: Static multilingual synonym dictionary
- **Pros**: zero runtime cost; fully deterministic; no Ollama dependency
- **Cons**: brittle for a personal app with evolving content; cannot handle proper nouns (artist names, film titles); cannot handle new slang or cross-language terms; maintenance burden grows with corpus diversity; cannot generate contextual expansions ("sad" → "malinconia" in Italian context)
- **Cost impact**: zero infrastructure, ongoing maintenance cost

## 5. Decision Rationale
Option A wins on the principle of minimal footprint for a personal app. The key observation: `qwen2.5:3b` is already warmed when the user is actively adding content (which is when they also search). The 5s timeout ensures that even under concurrent load, search never blocks waiting for expansion — it degrades gracefully to keyword-only results (BDR-0002). The `OLLAMA_TEXT_MODEL` env var decouples the code from the specific model, preserving the ability to upgrade to a better model without code changes.

## 6. Consequences

### Positive
- Zero new infrastructure or VRAM budget required
- Model upgrades (e.g., `qwen2.5:7b` or `llama3.1:8b`) require only env var change
- Consistent with existing Ollama integration patterns in the codebase
- Synonym quality adequate for personal use (≤10 synonyms per query, Italian + English)

### Negative
- Model not specialized for synonym generation — may produce generic or irrelevant expansions for niche music/film terminology
- VRAM contention possible during simultaneous content analysis and search
- If `OLLAMA_TEXT_MODEL` is changed for analysis quality reasons, expansion quality changes too (coupled)

### Follow-ups
- If expansion quality proves insufficient, consider a separate `OLLAMA_EXPANSION_MODEL` env var to decouple the two use cases
- Monitor Ollama response times; if p95 exceeds 3s regularly, tighten timeout or move to dedicated model

## 7. Guardrails
- `queryExpander.ts` MUST use `Promise.race([ollamaCall, timeoutPromise(5000)])` — timeout is non-negotiable
- On timeout or any Ollama error, function returns `[]` (empty array) — never throws
- Search route handles `[]` expansion by proceeding with original keywords only
- Expansion results logged to console for quality monitoring during development

## 8. Migration Plan
Already implemented. `queryExpander.ts` reads `process.env.OLLAMA_TEXT_MODEL ?? 'qwen2.5:3b'` and calls the Ollama `/api/generate` endpoint. No migration required.

To switch to a dedicated expansion model:
1. Add `OLLAMA_EXPANSION_MODEL` env var to `.env` and `docker-compose.yml`
2. Update `queryExpander.ts` to read `OLLAMA_EXPANSION_MODEL`
3. Pull new model: `docker exec soundreel-ollama ollama pull <model>`
4. Test expansion quality before deploying

## 9. Rollback
**Trigger**: query expansion consistently produces irrelevant synonyms that pollute search results (false positives exceed false negatives).

**Steps**:
1. Set `queryExpander.ts` to always return `[]` (disable expansion)
2. Search reverts to keyword-only FTS — still functional per ADR-0001
3. Evaluate static synonym dictionary (Option C) for the most common query patterns
4. Re-enable expansion with improved prompt or different model when ready

**Estimated effort**: 15 minutes to disable; hours to build a static dictionary fallback.
