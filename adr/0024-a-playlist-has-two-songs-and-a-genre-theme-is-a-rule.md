# ADR-0024: An automatic playlist has at least two songs, and a theme that names a genre is a rule on the genre, not a list of songs

## Status
**Accepted** (10 November 2026): Michele's three corrections after the first application of the automatic playlists (ADR-0023, SoundReel 2.20.1), designed with defaults he can correct (spec §5, P15–P18). **Built and tested** as SoundReel 2.20.2 and **in production since 10 November, 08:24** (his OK: «Sì, deploy e ripara»); the 56 playlists already made were **repaired at 08:27**: 15 became rules, 3 were taken apart, 38 stayed (53 automatic playlists now, none with fewer than two songs).

## Date
2026-11-10

## Owners
Michele Mondora

## Related
- spec `2026-11-10-auto-playlists-and-playlist-list-design.md` (§1.2, §3.A.11–13, P15–P18)
- ADR-0023 (the automatic playlists: **amended** by this one), ADR-0008 (dynamic playlists are rules evaluated at read time: the playlist of a genre is one), ADR-0018 (rule P: the server decides; the clients draw), ADR-0022 (the collections, still to be built: the genres are the first thing they will group by)
- `services/autoPlaylists.ts`, `services/genreThemes.ts`, `services/dynamicRules.ts` (the order `newest`), `scripts/repairAutoPlaylists.ts`, migration `022_auto_playlist_waiting.sql`

---

## 1. Context
After the first application of ADR-0023 to the whole library (56 playlists), Michele wrote, one message after the other:

> «attenzione, le playlist non possono essere di una sola canzone - vanno smontate, si chiamano "play list" 🙂»
> «inoltre la pagina canzoni ora con l'elenco delle play list è illeggibile»
> «e dall'altra es "Soul da ascoltare" mi aspetto che sia una dinamica deve avere il tag soul la canzone. oppure tutto il soul deve conferire in quella play list.»

Measured on the real library: five of the 56 playlists had **one** song (themes born from a single post: «Folk», «Cantautori», «Italo disco», «Lo-fi», «Musica per allenarsi»); «Soul da ascoltare» had 2 songs while **39** songs of the library carry the genre R&B/Soul, «Pop da ascoltare» had 3 while 131 are Pop, «Rock» 6 against 68. A theme named after a genre that holds only the songs of the posts the model happened to put there is **misleading**: the name promises the genre, the content is a sample.

## 2. Decision
1. **An automatic playlist has at least two songs** (`MIN_PLAYLIST_SONGS = 2`). It is **born** only when it has them. A theme that has one song **waits**: its post is remembered as `waiting` (a new status of `auto_playlist_runs`, with the theme in a new column `theme_key`), not made into a playlist of one. When a post of the same theme brings the **second different song** the playlist is born with **all** the songs that were waiting (newest first) and the waiting posts become `done`. A post that **lists** music (two songs or more) never waits. Playlists made **by hand** are not touched by this rule.
2. **A theme that names a genre the song metadata knows is a rule on that genre.** Twenty-three words of the closed list of themes (Jazz, Rock, Pop, Elettronica, House, Techno, Hip hop, Rap, R&B, Soul, Funk, Blues, Metal, Punk, Indie, Folk, Reggae, Latina, Classica, Colonne sonore, Cantautori, Ambient, Dance) map to **canonical genres** (`utils/genres.ts`). Their playlist is a **dynamic playlist** (ADR-0008) with a new rule order, **`newest`**: every song of the owner's library that has one of the genres, the last added first, up to 200, **without looking at the listening events**. The playlist is **born when the library has two songs with the tag** (the post is only the signal); **the tag decides what is in**, not the model. This is the first of the two ways Michele offered («una dinamica, deve avere il tag soul la canzone»); the second («tutto il soul deve conferire») would be a static copy to keep aligned with the tags and with whatever the user removed by hand.
3. **One theme per set of genres:** «Rap» and «Hip hop» (`Hip-Hop/Rap`), «R&B» and «Soul» (`R&B/Soul`) are the same playlist. Its `theme_key` is `genre:<canonical genres joined by +>`; the unique index `(owner_user, theme_key)` of ADR-0023 makes it true.
4. **Themes the metadata has no tag for stay lists of the songs of the posts:** Synthwave, Darkwave, Italo disco, Disco, Lo-fi, Musica italiana, the decades; the occasions («Musica per la notte»); the free titles of the lists. They are subject to decision 1.
5. **The playlist of a genre has no songs of its own**: a later post of the theme adds nothing and sends no message. The message says the playlist was born, with the number of songs the rule shows now.
6. **The rule order `newest` is part of the dynamic rules contract** (`docs/mondrop-stats.md` §4): `parseRule` accepts it, `ruleSummary` says «Aggiunte di recente · R&B/Soul · max 200» (no window, period or family), the web editor opens it as it is and greys out what does not count. Mondrop does not decode the rule: it shows `kind` and the server's `ruleSummary`, so **no app change**.
7. **The playlists already made are repaired by a script** (`repairAutoPlaylists.js`): **preview by default**, `--apply` only with Michele's OK, one transaction per playlist, the hand-made ones never touched. Genre themes with two tagged songs **become dynamic** (same playlist, same name; the songs of the posts are removed); doubles are **merged**; what has fewer than two songs is **taken apart**, **together with its theme in the registry** (a theme left without a playlist reads as «deleted by the user» and would never be made again), and its posts wait.
8. **The web Songs page** (the second correction) is a UI rule, in the spec (§4): the list of playlists is one closed row «Playlist (N)», scrolls inside a bounded box when open, two lines per row.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Static playlist of the genre, kept full by a job that copies every tagged song in | A copy of what the tag already says; the user's removals would be undone by the next run unless every removal is remembered; ordering newest-first needs the positions rewritten |
| Keep the playlist of one song and just hide it from the lists | Still a playlist of one song, and it would still count, be downloaded, be shared |
| Drop the song of a post whose theme has no playlist yet | The song of the first post of a theme would never be in it; waiting costs one status and one column |
| Waiting songs in a table of their own | The posts are already remembered by `auto_playlist_runs`; the songs are read again from the entry when the playlist is born |
| A new kind of playlist for the genres | The dynamic playlists already exist on the web and on Mondrop; one rule order is enough |
| Use the hashtags of the post as the tag | Michele said «deve avere il tag soul la canzone»: the song's own genre (the one the filters of the Songs page show); a hashtag belongs to the post, not to the song. Open question P17 |
| Decide the genre of a theme with the model | The metadata already says it; the model would make every playlist of a genre a sample again |

## 4. Consequences
- ✅ «Soul da ascoltare» is **every** soul song of the library (39, growing with every new tagged song, newest first) and is never wrong about its own name.
- ✅ No automatic playlist with fewer than two songs, ever (an invariant test runs mixes of posts through the engine).
- ✅ Additive: one column and one index, one new rule order; the installed apps keep working.
- ⚠️ A song enters a genre playlist **only when the metadata knows its genre** (the iTunes enrichment arrives after the analysis; 71 of the 816 songs with metadata have no genre): the song of a post may not be in the playlist its post created.
- ⚠️ The playlist of a genre is born **at the next post** of the theme once the library has two tagged songs (there is no periodic check yet).
- ⚠️ «Colonne sonore da ascoltare» passes from 70 songs (chosen by the posts) to 42 (the ones that carry the genre): that is the rule, and it is visible in the preview of the repair.
- ⚠️ A dynamic playlist cannot be edited by hand (add, remove, reorder answer `409`, ADR-0008): the user who wants a different content changes the rule or makes a playlist of his own.

## 5. Open questions
- **P17:** is the «tag» the genre of the song (as built) or the hashtags of the post?
- Should the playlists of a genre also appear for genres with no post at all (every genre with at least N songs), the way Spotify makes its genre mixes? That is the collections (ADR-0022), not this.
