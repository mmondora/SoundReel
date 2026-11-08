# ADR-0021: The server finds the lyrics on the Internet when a song has none, keeps them and serves them; the clients only ask SoundReel

## Status
**Accepted** (8 November 2026), SoundReel 2.19.0 is **in production since 8 November 2026, 20:13** (Michele: «Sì, deploy ora»; 162 read-only post-deploy checks passed; two real songs found on the Internet, three served from their post transcript); Mondrop 1.7.0 (build 10) is built and tested. Michele answered the open question of ADR-0019 («Sì, cercale su Internet»).

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-lyrics-from-the-internet-design.md` (L1–L11), spec `2026-11-08-player-cover-art-design.md` §4
- ADR-0018 (rule P: clients talk only to SoundReel), ADR-0019 (the same shape for covers: found, kept, served), ADR-0017 (`versionOf`)
- `services/lyricsFinder.ts`, `services/songLyrics.ts`, `services/offlineManifest.ts`, `docs/mondrop-sync.md`

---

## 1. Context
Michele (8 November): «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole.» and, asked whether the lyrics should be searched on the Internet when they are missing: «Sì, cercale su Internet». Today a song's «parole» are the transcript of the post (what Whisper hears in the video, often speech) or a text pasted by hand on the phone; lists do not carry them at all, so a song played from «Cerca», the library or the Home shows none even when a transcript exists.

## 2. Decision
1. **A route, `GET /api/mondrop/songs/:key/lyrics`**, answers with the text the **server** has for a song the user can play (journal or file-only): the transcript of the post if there is one, else the lyrics found on the Internet and kept, else `404`. The app asks SoundReel and nothing else (rule P).
2. **The Internet only when the text is missing.** The order on the phone is: what the user typed → what the server has (transcript) → what the server finds. A text that exists is never replaced.
3. **LRCLIB** (an open archive of lyrics, no key) through its search endpoint, with a User-Agent that names the app. Only the artist and the title go out. A **strong match** is required (same title once the markers in brackets or after a dash are removed, and a credited artist in common, with case, accents and punctuation folded): better no text than another song's words. A version (Speed, Slowed, Remix…) with no text of its own falls back to its original, except an Instrumental or a Karaoke.
4. **Found once, kept.** Table `song_lyrics`: a text found is kept; «not found» is remembered for 7 days; an outage of the archive is not an answer and is not remembered. One search per song at a time, and the requests are at least a second apart. `LYRICS_ONLINE=0` switches the Internet off.
5. **The phone keeps what it has seen** (so the words are there offline) and the sheet says where they come from.
6. **Rights:** lyrics are copyrighted. They are kept for the private use of the family, shown only in the family's app, never published, and nothing outside the server and the phones holds a copy.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| The app asks the archive itself | Against rule P; every client would carry the matching rules, the throttle and a fix for every change of the archive; no shared copy |
| Scrape a lyrics site (Genius, Musixmatch pages) | Against their terms and fragile; LRCLIB is built to be used by apps |
| Replace the transcripts with the Internet text | Michele said «quando mancano»; a transcript can be what the user wants. One line to change if he asks |
| Search on every play | A request per play for a text that does not change; kept after the first one |
| Fuzzy matching («best guess») | A wrong text is worse than none (it looks right); the strong match is the same bar as for covers and years |
| Keep the texts in files like the covers | They are small text, and a table answers «found / not found at this date» with one read |

## 4. Consequences
- ✅ Songs with no transcript (most of the library) get words; songs played from lists get the transcript too (fixes the gap).
- ✅ Additive: a new route and a new table; installed apps are unchanged.
- ⚠️ LRCLIB is community-sourced: a text can be incomplete or have mistakes; the sheet says it comes from the Internet.
- ⚠️ The first play of a song waits for one request (about a second) to show its words; later ones are kept.
- ⚠️ A song title that is common and an artist that is credited the same way as another song could still match the wrong text; the version fallback widens this a little (it is skipped for Instrumental and Karaoke).

## 5. Open questions
None. The synchronized lyrics (karaoke), the web player, translation and other archives are not asked for (spec L10).
