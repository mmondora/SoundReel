# ADR-0033: Mondrop shows what a reel contains, decomposed and explained by the server; only the music goes to the phone

## Status
Accepted (12 November 2026), in production in SoundReel 2.27.0 (17:40) and on TestFlight in Mondrop 1.8.0 build 20 (internal group, 17:44), both with Michele's OK. Amends ADR-0020 (the Home no longer has the «recent» section) and the «every card links back to the post» rule of ADR-0017 **for Mondrop only** (the site keeps the links). **Amended the same day (evening) by Michele's answer to Q3, «si apri sulla scheda»** (decision 8): the page of a film has an «Apri» on its IMDb sheet — SoundReel 2.28.0 **in production since 13 November (00:15, revision `a290ace`), with Michele's OK**, and Mondrop build 21 on TestFlight since 13 November (00:27, internal group Family only, with his OK).

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
1. **The server decomposes and explains; the app draws.** Three read-only routes under `/api/mondrop` (`GET /reels`, `GET /reels/:id`, `GET /reels/:id/image`) built from what the analysis already saved: no model, no external call, no queue (rule P: the app asks only SoundReel, and no field of the reel's own words and things names a store or an address; the tracks of the music are the library's ordinary tracks and keep their legacy `coverUrl`, a cover address of the music provider that the app never fetches: it asks SoundReel for the cover through `coverPath`).
2. **No link to the reel.** The responses carry no `sourceUrl` (nor `mediaUrl`, `imdbUrl`, `url`): Michele wants «non il link al reel ma la sua scomposizione e spiegazione». The site keeps its links (ADR-0017). The one address an answer may carry is the sheet of a film (decision 8).
3. **Only the music goes to the phone.** The songs of a reel are the ordinary Mondrop tracks (`buildTracks`: played, downloaded and put in playlists like any song); everything else is text read from SoundReel and **not kept on the phone** (a cache of thumbnails in the system `Caches` only).
4. **Categories** are the ones the extraction has: music, films, software and the notes by category (places, books, products, brands, people, events, quotes). The category «other» of the notes and the values that are not categories of things (`tag`, `note`, empty) are **not shown** (what the model could not classify). The same thing never appears twice in a reel (software, places, products, brands, people and events are one family and the first category wins; a film, a book, a quote or a song is never merged with anything else).
5. **Visibility is the one of every list:** the reels the key's user owns or that were shared with them (`visibilitySql`, always in the `WHERE`, always a parameter); an id that is not readable is a `404`.
6. **The tab replaces «Share» on the bar** (five tabs: a sixth would fold the rest into «Altro» and hide the badge of the Posta); the manual share form opens from a «+» in the Reel tab.
7. **The Home has no «Ascoltati di recente»** (Michele: «gli Ascoltati di recente non mi interessano in homepage»): the server stops sending the section (ADR-0020: the server composes the Home).
8. **«Apri» on the sheet of a film** (amendment; Michele, answering Q3 of the spec: «Q3 si apri sulla scheda»). A film item of the page of a reel (`GET /reels/:id`, `sections[].items[]` of the `film` category) may carry `openUrl`: the page of the film on IMDb, **built by the server** as `https://www.imdb.com/title/<id>/` from the id (`tt` and 7 to 10 digits) of an address that is an IMDb title page (`imdb.com`, with at most `www.` or `m.`, nothing between the host and `/title/`: no credentials, no port, no longer host). Any other value — another site, a person page, a search, the address of the post, text that is not an address — gives **no `openUrl`** (the key is absent). It is on films only: **a software has none** (the analysis has an address for 1 software in 1 370: the model writes `url` only when the text of the post carries one, so the button would almost never appear), and a card of the list has none. The app opens it **only on a tap**, only if it is a web page on https with a host and no credentials, and the button says where it goes («Apri su imdb.com»). The address of the reel stays out of every answer.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Send the whole `results` of the entry and let the app decide | Breaks rule P (the app would choose categories, drop junk, merge duplicates) and ships the post address, the transcript and the raw model output to the phone |
| The app reads the site's entry routes (`/api/entries`) | They sit behind the site's login (Authelia), not behind the Mondrop key; they carry `sourceUrl` |
| Keep the reels on the phone for offline | Not asked: «l'unica cosa che viene portata sulla device è la musica» |
| A sixth tab | iOS folds the sixth on an iPhone into «Altro» and a badge there is not seen |
| Hide «recent» in the app | The server composes the Home (ADR-0020); hiding it in the app would leave two places that decide |
| «Apri» on the site of a software too (the other half of Q3) | Not built: 1 software in 1 370 has an address in the analysis; a button that appears once in a thousand cards is not a feature, and a web search link would be a guess. Michele's answer named the sheet, the film's. If it is wanted, the way is to find the official site on purpose (a source of truth, not the words of a model) |
| Pass `imdbUrl` as the analysis saved it | It is the model's or the post's text until proven otherwise: the server builds the address from the id and sends nothing else, so no address written by a post or by a model reaches the phone (a phishing page, the post itself) |

## 4. Consequences
- ✅ The family sees what a reel said and what it contained, with the songs playable, without leaving Mondrop.
- ✅ No new table, no migration, no model call: one read per page.
- ⚠️ The explanations come from a local model and can be wrong (the «approfondimenti» of the site have the same limit): the app labels them «Generato dall'IA»; the summary of the post is the explanation; the verdict is shown only where the post has one.
- ⚠️ A list of 1 700 reels is read from JSONB with a filter that is only approximate for placeholders; a card with nothing to show is rare and harmless.
- ✅ A film of a reel opens on its IMDb sheet (498 of the 741 films of the 1 665 reels of 12 November have one) without opening the reel.
- ⚠️ **Found on the real server after the deploy of 2.28.0 (13 November):** the tracks of the music section carry the legacy `coverUrl` (Apple and Deezer cover addresses: 150 values on the 268 pages of reels with a film), because they are the library's ordinary tracks. Decision 1, the contract and the release notes of 2.27.0 and 2.28.0 said «no address»: they now say «none in the words and things of the reel». The app never fetches it (`CoverLoader` builds its request from `coverPath`, always to SoundReel), so nothing leaks; dropping `coverUrl` from the reel tracks, like `mediaUrl`, is one line and one test (2.28.1) if Michele wants the claim to be true to the letter. My offline run on the 1 665 real reels had passed no tracks to the builder, and the test fixtures have `coverUrl: null`, which is why neither saw it.
- ⚠️ A software found in a reel cannot be opened from anywhere in Mondrop (no data, see decision 8). The match of the films with the database is sometimes wrong — a generic word like «movies» was matched to a film of 2026 — and «Apri» opens what the analysis matched, as the site does.
- Apps older than build 20 do not know the tab and never call the routes; a server older than 2.27.0 answers `404` and the new app says «Serve un SoundReel più recente».
- A server 2.27.0 does not send `openUrl`: the app draws no «Apri» and the rest works as before; build 20 ignores the field.
