# Mondrop — sync offline file Spooty / libreria

- **Date:** 2026-11-07
- **Status:** Implementing (interim API key) — OIDC Geeko resta upgrade
- **Owner:** Michele

## Goal

In Mondrop: scaricare / sincronizzare i file (Spooty/libreria **e** media IG/yt-dlp già su disco), riprodurli **in locale**, senza Apple Music obbligatorio.

## Decisions (2026-11-07)

| Scelta | Valore |
|--------|--------|
| UX v1 | Sync **playlist** → file offline + **player locale** in Mondrop |
| Fonte file | 1) Libreria MP3 2) entry `audio.wav` / `video.mp4` (Instaloader/yt-dlp) 3) enqueue Spooty se manca |
| Auth cellulare (interim) | `X-SoundReel-Key` + `X-SoundReel-User` su `/api/mondrop/*` (Traefik PathPrefix come `/api/share`) |
| Auth a regime | OIDC Bearer (Geeko) |
| Qualità | File già presenti, **nessuna** transcodifica al ribasso lato client |

## Shipping now

- Backend `/api/mondrop/…` + Traefik router `soundreel-mondrop`
- Mondrop tabs: Share / Playlist / Offline / Impostazioni
- Web player: preferisce `/api/songs/:key/file` se `inLibrary`

## After OIDC — implementation order

1. **Backend**
   - `GET /api/playlists/:id/offline` → manifesto `{ tracks: [{ songKey, title, artist, status: ready|missing|queued, bytes?, downloadPath }] }`
   - `POST /api/songs/:songKey/spooty` → enqueue Spotify URL a Spooty (riusa `postToSpooty`)
   - `GET /api/songs/:songKey/file` → stream MP3 con `Authorization: Bearer` (e Range); **404 JSON** se manca (niente redirect Spooty HTML per client nativi)
   - Validazione JWT Authelia (JWKS) condivisa con `/api/share`
2. **Traefik (Geeko)** — path Mondrop autenticati via Bearer app-side; host resta `soundreel.casamon.dev` (forward-auth cookie per browser; app manda Bearer e può usare path già pubblici o middleware che accetta JWT — da concordare con Geeko)
3. **Mondrop**
   - Login OIDC → token in Keychain
   - UI playlist + **Sync locale**
   - Download files in App Group / Documents
   - `AVPlayer` coda locale (prev/next/play)

## Non-goals (v1)

- Sync film/MP4 Tesla USB
- Background download iOS policies raffinate (prima foreground / URLSession basic)
- Apple Music / iCloud Music

## Related

- Roadmap: `ROADMAP.md` § Client iOS / Mondrop
- Player web Tesla resta YouTube finché non c’è path file anche sul web (separato)
