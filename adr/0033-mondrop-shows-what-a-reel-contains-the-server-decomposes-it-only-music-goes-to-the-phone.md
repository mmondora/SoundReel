# ADR-0033: Mondrop shows what a reel contains, decomposed and explained by the server; only the music goes to the phone

## Status
Accepted (12 November 2026), built and tested in SoundReel 2.27.0 and Mondrop 1.8.0 build 20 (not in production and not on TestFlight until Michele says so). Amends ADR-0020 (the Home no longer has the «recent» section) and the «every card links back to the post» rule of ADR-0017 **for Mondrop only** (the site keeps the links).

## Date
2026-11-12

## Owners
Michele Mondora

## Related
- spec `2026-11-12-mondrop-home-play-loop-reels-design.md` (the request, the decisions M1–M5, the contract of §4)
- ADR-0018 (rule P: the clients talk only to SoundReel), ADR-0020 (the Home is composed by the server), ADR-0017 (one thing, one entry; cards link to the post), ADR-0022 (collections), ADR-0029/0030/0031 (the phone first, the order of the downloads)
- contract for the clients: `docs/mondrop-reels.md`

---

## 1. Context
Michele (12 November): «Voglio avere anche un tab con le altre categorie sul reel ( dove però per ora l'unica cosa che viene portata sulla device è la musica ) ma non il link al reel ma la sua scomposizione e spiegazione.»

Mondrop today only knows songs: the rest of what SoundReel extracts from a reel (films, software, places, books, products, the summary, the explanations the model wrote) is visible only on the site. The data is already in the `entries` table (`results`: `summary`, `songs`, `films`, `software`, `notes` with a category, `enrichments`, `slides`, `tags`; 1 743 entries, 1 652 with a summary, 733 with songs, 265 with films, 701 with software, 1 537 with notes, 1 020 with explanations, 998 carousels) and 1 601 entries have a local 320 px thumbnail.

## 2. Decision
1. **The server decomposes and explains; the app draws.** Three read-only routes under `/api/mondrop` (`GET /reels`, `GET /reels/:id`, `GET /reels/:id/image`) built from what the analysis already saved: no model, no external call, no queue (rule P: the app asks only SoundReel, and no field names a store or an address).
2. **No link to the reel.** The responses carry no `sourceUrl` (nor `mediaUrl`, `imdbUrl`, `url`): Michele wants «non il link al reel ma la sua scomposizione e spiegazione». The site keeps its links (ADR-0017).
3. **Only the music goes to the phone.** The songs of a reel are the ordinary Mondrop tracks (`buildTracks`: played, downloaded and put in playlists like any song); everything else is text read from SoundReel and **not kept on the phone** (a cache of thumbnails in the system `Caches` only).
4. **Categories** are the ones the extraction has: music, films, software and the notes by category (places, books, products, brands, people, events, quotes). The category «other» of the notes and the values that are not categories of things (`tag`, `note`, empty) are **not shown** (what the model could not classify). The same thing never appears twice in a reel (software, places, products, brands, people and events are one family and the first category wins; a film, a book, a quote or a song is never merged with anything else).
5. **Visibility is the one of every list:** the reels the key's user owns or that were shared with them (`visibilitySql`, always in the `WHERE`, always a parameter); an id that is not readable is a `404`.
6. **The tab replaces «Share» on the bar** (five tabs: a sixth would fold the rest into «Altro» and hide the badge of the Posta); the manual share form opens from a «+» in the Reel tab.
7. **The Home has no «Ascoltati di recente»** (Michele: «gli Ascoltati di recente non mi interessano in homepage»): the server stops sending the section (ADR-0020: the server composes the Home).

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Send the whole `results` of the entry and let the app decide | Breaks rule P (the app would choose categories, drop junk, merge duplicates) and ships the post address, the transcript and the raw model output to the phone |
| The app reads the site's entry routes (`/api/entries`) | They sit behind the site's login (Authelia), not behind the Mondrop key; they carry `sourceUrl` |
| Keep the reels on the phone for offline | Not asked: «l'unica cosa che viene portata sulla device è la musica» |
| A sixth tab | iOS folds the sixth on an iPhone into «Altro» and a badge there is not seen |
| Hide «recent» in the app | The server composes the Home (ADR-0020); hiding it in the app would leave two places that decide |

## 4. Consequences
- ✅ The family sees what a reel said and what it contained, with the songs playable, without leaving Mondrop.
- ✅ No new table, no migration, no model call: one read per page.
- ⚠️ The explanations come from a local model and can be wrong (the «approfondimenti» of the site have the same limit): the app labels them «Generato dall'IA»; the summary of the post is the explanation; the verdict is shown only where the post has one.
- ⚠️ A list of 1 700 reels is read from JSONB with a filter that is only approximate for placeholders; a card with nothing to show is rare and harmless.
- ⚠️ Without the link, a software or a film found in a reel cannot be opened from anywhere in Mondrop; an «Apri» on the thing itself (not the reel) would be one more field (spec §8, Q3).
- Apps older than build 20 do not know the tab and never call the routes; a server older than 2.27.0 answers `404` and the new app says «Serve un SoundReel più recente».
