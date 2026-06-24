# ADR-0002: simple FTS Dictionary for Mixed IT/EN Content

## Status
Accepted

## Date
2026-06-23

## Owners
Michele Mondora

## Related
- `backend/src/db/init.sql` (trigger function `entries_build_search_vector`)
- ADR-0001: Postgres FTS over pgvector for search
- ADR-0003: Reuse qwen2.5:3b for query expansion

---

## 1. Context
SoundReel entries contain mixed Italian and English text in the same document: Instagram captions may be Italian, AI-generated summaries from Ollama default to English, song titles are in the original release language (often English), film titles appear in both Italian and English depending on the source. Postgres FTS requires a text search configuration (dictionary) to tokenize and normalize search vectors. The dictionary choice directly determines which terms survive tokenization and which are stripped or transformed by stemming.

## 2. Decision
Use the `simple` Postgres text search dictionary for all FTS operations — both `to_tsvector` in the trigger and `websearch_to_tsquery`/`to_tsquery` in queries.

## 3. Drivers
- Mixed-language documents make any single-language dictionary lossy
- Ollama synonym expansion (ADR-0003) substitutes for stemming in query-time recall
- `simple` dictionary is always available in Postgres without extension installs
- Stemming errors in cross-language documents produce silent data loss at index time

## 4. Options Considered

### Option A: `simple` dictionary (chosen)
- **Pros**: language-agnostic; no stemming means no false normalization; both Italian and English terms indexed as-is; query terms also unstemmed so index/query symmetry is maintained; works correctly on song titles, hashtags, and proper nouns
- **Cons**: no stemming means "canzoni" and "canzone" are different tokens; plural/singular and verb conjugations not unified; compensated by Ollama expansion at query time
- **Cost impact**: zero

### Option B: `italian` dictionary
- **Pros**: correct Italian stemming (canzone/canzoni unified); stop-word removal for Italian
- **Cons**: corrupts English terms — "songs" may be mis-stemmed or dropped; song titles in English indexed incorrectly; stop-word list removes common English words that may be meaningful in context; breaks cross-language queries
- **Cost impact**: zero

### Option C: `english` dictionary
- **Pros**: correct English stemming; handles English captions and song titles well
- **Cons**: Italian terms stemmed incorrectly or dropped via Italian stop-words not recognized; AI summaries in Italian (from Ollama) would be partially lost; inverse problem of Option B
- **Cost impact**: zero

### Option D: `unaccent` + language detection per document
- **Pros**: theoretically optimal — stem each language correctly
- **Cons**: requires language detection logic (another Ollama call or `pg_catalog` extension); per-document configuration; significant implementation complexity for minimal gain given Ollama expansion is already providing synonym recall
- **Cost impact**: additional Ollama calls per ingested entry

## 5. Decision Rationale
The core trade-off: stemming provides recall (finding "canzoni" when searching "canzone") but at the cost of cross-language correctness. Since entries contain both Italian and English in the same document, any language-specific dictionary applies the wrong normalization to roughly half the content. `simple` avoids this by not stemming at all. The recall gap is closed by Ollama synonym expansion at query time: when a user searches "canzone", the expander returns "canzoni", "song", "brano", etc., which are all indexed verbatim under `simple`. This is a better separation of concerns: indexing preserves fidelity; expansion provides recall.

## 6. Consequences

### Positive
- Italian and English terms indexed without corruption
- Song titles (often proper nouns or mixed-language) indexed exactly as they appear
- Hashtags and usernames preserved verbatim
- Perfect index/query symmetry — no surprises from asymmetric stemming

### Negative
- Plural/conjugation variants require Ollama expansion to surface (not automatic)
- Stop-word removal does not occur — minor index size increase vs. language-specific dicts
- If Ollama expansion is unavailable, searches for "canzoni" won't find entries with only "canzone"

### Follow-ups
- If Ollama expansion quality proves insufficient for stemming-related misses, evaluate `pg_trgm` trigram index as an additional layer (handles prefix/suffix matching)

## 7. Guardrails
- Index trigger must use `simple` consistently: `to_tsvector('simple', ...)` — not `to_tsvector(caption)` which would use the server default locale
- Query functions must also use `simple`: `websearch_to_tsquery('simple', ...)` and `to_tsquery('simple', ...)`
- Verify with: `SELECT to_tsvector('simple', 'canzoni songs') @@ to_tsquery('simple', 'canzoni & songs');` — must return `t`

## 8. Migration Plan
Already implemented. Dictionary is hardcoded as `'simple'` in both the `entries_build_search_vector` trigger function and the search route. To change dictionary:

1. Update `init.sql` trigger function to use new dictionary
2. Update `search.ts` query functions to match
3. Rebuild all search vectors: `UPDATE entries SET search_vector = entries_build_search_vector(caption, results);`
4. Verify index is still used: `EXPLAIN SELECT * FROM entries WHERE search_vector @@ websearch_to_tsquery('new_dict', 'test');`

## 9. Rollback
**Trigger**: cross-language search quality is acceptable but stemming misses (singular/plural) exceed Ollama's compensation ability.

**Steps**:
1. Determine dominant language of the corpus (likely Italian for captions, English for summaries)
2. Create a custom dictionary combining `italian` + `english` unaccent if needed
3. Update trigger and query to use new config
4. Rebuild vectors: `UPDATE entries SET search_vector = entries_build_search_vector(caption, results);`
5. Re-test cross-language queries

**Estimated effort**: 2–4 hours, including reindex time.
