# ADR-0022: The server discovers the collections of the library by itself, names and keeps them; the clients only draw them

## Status
**Accepted** (10 November 2026): Michele chose the UX, the threshold and the seed names («1 si, - 2 no, - 3 5 voci - 4 ok.») and added two requests (places read from the text with the names of the venues and a Google Maps link; automatic playlists, ADR-0023). **Phase 1 built on 10 November for SoundReel 2.24.0** (spec §10; contract `docs/collections.md`): vectors, places and venues, the grouping with ids that survive, names from a seed list, corrections that last, the routes, and the site (chip rail, «Raccolte» page, a collection with its venues and «Apri in Maps», chips on the cards, the shelf on the Home). **In production since 10 November 2026 (SoundReel 2.24.0, deployed with Michele's OK); no collection is published yet:** the backfill of the existing entries and the first publication are separate steps, each with its own OK (spec status line). Calibrated on the real library (spec §3.1): group cosine 0.42, merge 0.64 (not +0.12), absorption 0.80 plus a 70 % rule on the members. A read-only trial on the real library (9 November) shows the discovery works (spec §3).

## Date
2026-11-09 (accepted 2026-11-10)

## Owners
Michele Mondora

## Related
- spec `2026-11-09-library-collections-auto-topics-design.md` (C1–C18)
- ADR-0023 (automatic playlists from the posts that talk about music: the same «the server decides» shape, and the first to be built)
- ADR-0001 (Postgres FTS over pgvector: kept, still no pgvector), ADR-0017 (one identity per thing; every card links to its post), ADR-0018 (rule P: clients talk only to SoundReel), ADR-0020 (the server sends sections ready to draw), ADR-0015 (the outcome of a share says where it went), ADR-0021 (the same shape: the server finds, keeps, serves)
- `services/softwareExtraction.ts` (the dedicated second call that never fails the analysis), `services/ollamaClient.ts`

---

## 1. Context
Michele (9 November): «vorrei che crei una serie di aggregazioni, proponendo alcune di base, sulle viste che possono uscire dalle voci in libreria, ad esempio "ristoranti", "ristoranti a milano", "musica", "wallpaper", "casa", "montagna", "ricette" ecc. […] Vorrei sia tutto automagico, ad esempio "vino" viene scoperto da solo e proposto.» On 10 November he added: «Voglio anche che il luogo venga identificato dal testo ( es: voce che dice "ecco i ristoranti nuovi da provare su milano" e in tal caso voglio anche una sezione con i nomi dei ristoranti ) e abbia un link a googlemap (oppure apri in gmap ).»

The library has 1696 entries (347 saved in October alone) and is shown as a list by date; there are pages per **type** (songs, films, notes, software) but none per **topic**. The tags the model writes cannot be the key: 3256 distinct ones, the most frequent are placeholders copied from the prompt (`#tag` in 129 entries, `@utente` in 75), and one theme is split into variants (`#ai`, `#aitools`, `#intelligenzaartificiale`, `#aiagents`…). Keyword lists miss what nobody listed, which is the point of the request.

## 2. Decision
1. **A collection is a derived view over entries**, owned by one user (his own entries and the ones shared with him), in three layers: **types** (music, films, software, places, books: **computed predicates** on the extraction, exposed by the API as virtual collections, not stored), **themes** (discovered; the only rows in `collections`; two levels: a theme and its children) and **places and combinations** (a theme × a place, **computed**, never written by hand). The headings of the page («Cibo e bevande»…) are fixed labels of the seed table, not collections.
2. **The server discovers the themes.** Each entry gets a vector (`nomic-embed-text`, already on the local Ollama, from the summary and the cleaned tags, centered on the library mean); the nightly pass regroups **all** the vectors; a group is a collection when it has **5** entries (Michele) and is coherent, it is only «watching» at 3–4 and dies below 3; a new group **inherits** the id and the name of the old collection it shares at least half of its members with. A group that is musical or about films is not a theme (it is already a type). The types come from the extraction, **not** from the grouping. An entry belongs to at most 2 themes and to the parent of each. **The night never makes the first publication:** the pass consolidates only an owner who already has a collection (any row, in any state); the first ones are made by `rebuildCollections --apply`, after a look at its preview with Michele, so that nobody sees names the local model found before the owner has seen them. **Precision comes before recall for places and venues** (measured on the real library on 10 November): a venue needs evidence in the text and its kind is the kind of its word, never the model's (14 true venues of 15, about 40 % recall); and **a country is no collection** (it is named in passing, and a place cannot be hidden by the user).
3. **The name comes from a seed list** (about 30 Italian names, accepted by Michele) chosen by the local model and then cleaned (symbols, spelling, exact list name); a new name is accepted only if it has 1–3 words and one of its words is in at least 30 % of the members; else the dominant tag; else the group is **not published** and is retried. A name changed by the user is never touched again.
4. **Places are read from the text** (Michele): the place the model returns **must appear in the text of the entry** (a literal check after cleaning) and be in a list of places; the facet «where» lists the places named by at least 2 entries, a combination needs 5. **Not** from the geocoding of the notes that exists today (it gives «Luogo» → Cremona, «Montagna» → Reims), and **no coordinates** are stored.
5. **Venues and Google Maps** (Michele): a dedicated call finds the **proper names** of the venues a post lists (they must appear in the text; nothing is invented); one row per venue even if several posts cite it (ADR-0017); the **server builds the link** (`https://www.google.com/maps/search/?api=1&query=<name>, <place>`, no key, no call to Google, nothing leaves until the user taps). No map of our own.
6. **Corrections always win and last:** rename, merge, hide, «not this one», «add to…», in their own rows, applied after every recomputation.
7. **Rule P:** the clients only draw. The server answers with the collections already ordered, with `views` and `defaultView`, with the chips of each entry and with `mapsUrl`. **Only the site** shows collections (Michele, Q2: no on Mondrop); a section for Mondrop could be added later under the same rule.
8. **Everything local** (Ollama through the gpu-router; never Claude; nothing leaves), vectors stored as `REAL[]` in Postgres and compared in memory (1700 × 768 floats is about 5 MB; no pgvector). Kill switch `COLLECTIONS_AUTO=0`; the rebuild script is a preview by default.
9. **Announce, don't ask:** a new collection is active at once, with a «new» mark for 7 days and a strip on the site's Home. The first run announces once («N collections found»).

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Group by the tags the model already writes | 3256 distinct, placeholders, one theme split in many variants |
| Keyword lists per topic («vino», «ristorante»…) | Cannot find what nobody listed; and wrong often: «ricette» matched Tesla and AI dashboards while the true count of recipes is 2–3 |
| The LLM classifies every entry into a fixed taxonomy | A fixed list does not discover; about a second per entry; names unstable. Kept only for **naming**, **places** and **venues** |
| Cluster, then let the LLM name freely | Tried on the real library (spec §3): `#`/`@` in names, typos, a broken JSON as a name, a wrong parent; the seed list, the cleaning and the evidence check fixed most of it |
| pgvector | An extension and its ops for 1700 vectors; ADR-0001's reasoning holds |
| Ask the user to approve each new collection | Michele asked for everything automatic; announce and allow undo instead |
| Group in the client | Against rule P: every client would carry the thresholds and the names |
| Claude for naming | The project keeps this work local; cost; data would leave |
| A map of our own, with coordinates for every venue | Michele asked for a Google Maps link; coordinates would need geocoding that is wrong today |
| Store the types, the places and the combinations as rows | They are predicates and facets; rows would need their own birth, death, announcement and hiding for no gain |

## 4. Consequences
- ✅ The library can be browsed by theme, place and type, and niches appear by themselves (a trial found «Vino» with 15 entries and the restaurants of Milano without being told).
- ✅ A post that lists venues gives a list of names with a link to open each one in Google Maps.
- ✅ Additive: new tables and routes; entries are untouched; the collections can be rebuilt (only the corrections are original data).
- ⚠️ The names, places and venues of a local model are unstable: seed list, cleaning, literal check in the text, retry, and the user's correction wins.
- ⚠️ Groups can flicker as entries arrive: inherited ids and hysteresis (born at 5, dies below 3).
- ⚠️ Half of the library is one theme (AI and development): the hierarchy is needed or the rail would be one chip.
- ⚠️ The thresholds are calibrated on this library and this embedding model (vectors centered on the mean); a new model means recalibrating and recomputing (`model` is in the table). Phase 0 redoes the calibration inside the code.
- ⚠️ A one-off of about two and a half hours (5.5 s per entry on average, measured on 618 real calls) of local work for the places and venues of the 1700 existing entries (queued, never together with analyses).
- ⚠️ The list rows lose the placeholder tags (`#tag`, `@utente`, `#hashtag`); the stored data keeps them and the real tags stay.

## 5. Open questions
None from the proposal (Michele answered Q1–Q4). The numbers of the first phase (threshold of coherence, of merging, of absorption) are fixed by the calibration of phase 0 on the golden set of the spec.
