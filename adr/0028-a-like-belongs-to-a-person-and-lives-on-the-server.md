# ADR-0028: A like belongs to a person and lives on the server; the phone only draws it and sends it

## Status
**Accepted** (Michele's answers of 10 November: «1 si, 2 si, 3 ora»: the «Mi piace» playlist, the like of each person, and the test in the car now; nothing is in production: the app is being built first, the server follows the 2.24.0 release)

## Date
2026-11-10

## Owners
Michele Mondora

## Related
- spec `2026-11-10-mondrop-like-and-repeat-design.md` (L1–L8), contract `docs/mondrop-likes.md`
- ADR-0018 (rule P: the clients draw, the server decides), ADR-0015 (the server keeps the state; the phone keeps a queue until it can tell it)
- `docs/mondrop-stats.md` (the listens: per user and device, with an offline queue on the phone: the same pattern)

---

## 1. Context
Michele (10 November): «in mondrop voglio il like sulla canzone e il loop da player bluetooth es dalla auto».
- Mondrop has no like today. The site has a «favorite», a like / dislike and a score on every song, in `song_meta`, whose key is **the song alone**: one value for everybody, a leftover of the single-user period. It is written by `PATCH /api/songs/:key`, behind Authelia.
- The family now uses Mondrop with **one key per person and device** (`X-SoundReel-Key` → user); playlists, listens, collections and the inbox are already **per user**. A like given on the phone of one person must not become a like of the others.

## 2. Decision (proposed)
1. **A like is one row per person and song**, in a new table `song_likes (user_id, song_key, liked_at)`, primary key `(user_id, song_key)`. There is no «dislike» in this table.
2. **It lives on the server** (rule P). The phone keeps a copy to draw instantly and a queue of the operations it could not send yet, in order, and replays them when there is a network (the pattern of the listens).
3. **Three routes under `/api/mondrop`** (contract `docs/mondrop-likes.md`): the set of the person's likes, `PUT` and `DELETE` of one like, both idempotent. The user is the one of the key, never the body, the query or the path. No change to the manifests, the library or the search: the app joins the set to the song it shows.
4. **The site's favorite / like / dislike do not change**: they stay a value of the song for everybody (curation of the journal). The two concepts can be merged later (the site reading the person's likes) if Michele wants; nothing here makes that harder.
5. **A dynamic playlist «Mi piace» per person** (Michele: «1 si»): a new rule of the dynamic playlists, «the songs I like», the most recently liked first (at most 200), made at the person's first like and never made again if the person deletes it. Mondrop and the site draw it like any dynamic playlist.
6. **The remote commands of the phone** (what Bluetooth, the car and the lock screen can press) are the way a like and the repeat mode are reached from outside the app: `likeCommand` and `changeRepeatModeCommand` of `MPRemoteCommandCenter`. What a given car shows is decided by the car (spec §4): it is verified on the real car, and the app promises nothing the car does not show.

## 3. Alternatives considered
| Option | Why not (as the default) |
|---|---|
| Reuse `song_meta.rating = 'like'` / `favorite` | One value for everybody: a like of one person would show as a like of all the others, and it would be overwritten. It has no «when» either |
| Keep the like only on the phone | Lost with the phone, not visible on the other devices of the person or on the site, nothing for a playlist to be built from |
| Put `liked` in every track of every manifest, the library and the search | Touches every route that builds tracks to carry one boolean; a separate set joined by the app does the same with one route |
| Make the site's like per person at the same time | Right in the end, but it changes a screen and a meaning that nobody asked to change now |

## 4. Consequences
- ✅ A like is private to the person who gave it, survives a lost phone, works on every device of that person and is ready for a playlist («Mi piace», proposed in the spec, not built unless Michele says yes).
- ✅ Small: one table, three routes, no change to existing routes.
- ⚠️ **Two meanings of «like» coexist for a while** (the site's, for everybody; Mondrop's, per person). The names say so in the interface («Mi piace» on the phone) and the spec records the way out.
- ⚠️ A key is not checked against the library: a like for a song that does not exist is stored anyway (harmless, and a file-only song has a key of its own).
- ⚠️ The like from the car is **not guaranteed**: it depends on what the head unit shows (verified in phase F3, with the fallback of Siri in the spec).

## 5. Open questions
None from Michele's side (spec §10). Left to verify: what the Tesla shows and sends over Bluetooth (phase F3, on the real car), and that the rule editor of the site and the apps up to build 12 cope with the new rule (phase F2).
