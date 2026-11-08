# Mondrop ↔ Authelia (OIDC)

## Obiettivo

- Ogni utente fa **login Authelia sul proprio iPhone/Mac** (niente API key mintata a mano da Michele).
- Identità = username Authelia (`mike` / `archi` / `sara`).
- Share Extension legge utente + token da App Group / Keychain.

## Stato (2026-11-07)

| Pezzo | Stato |
|--------|--------|
| Share con `X-SoundReel-Key` + picker utente | Interim, funzionante |
| Key personale self-service (`/mondrop/connect`, Ottieni/Rinnova in app) | Implementato 2026-11-07 (da deployare) |
| Authelia OIDC IdP | **Richiesto a Geeko** — inbox `geekom-hub/inbox/2026-11-07-authelia-oidc-mondrop.md` |
| Client OIDC `mondrop` + Mondrop app + Bearer su `/api/share` | **Bloccato** finché Geeko non comunica «fatto» |

Discovery oggi: `GET https://auth.casamon.dev/api/oidc/.well-known/openid-configuration` → 404.

Allineamento hub: ADR-0030 (LiteLLM SSO) prevede già Authelia come IdP; Mondrop aggiunge un **client pubblico** PKCE.

## Flusso target

1. Mondrop → «Accedi con Authelia» → `ASWebAuthenticationSession`
2. Authelia authorize + token (`openid profile`)
3. App salva access/refresh in Keychain; `preferred_username` in App Group
4. Share: `Authorization: Bearer <access_token>` su `POST /api/share`
5. Backend valida JWT (JWKS Authelia), imposta `owner_user` dal claim — ignora/override body.user se mismatch

## Parametri client (attesi da Geeko)

- `client_id`: `mondrop`
- `redirect_uri`: `mondrop://oauth/callback`
- PKCE S256, `token_endpoint_auth_method: none`
- Policy: gruppo `family` (o equivalente casa)

## Dopo il «fatto» di Geeko

1. Verificare discovery + prova authorize da Safari
2. Backend: validazione Bearer (JWKS) su `/api/share` (key resta fallback admin)
3. Mondrop: login UI, Keychain, Share Extension senza campo API key
4. Deprecare mint-key per utenti famiglia
5. **Sync offline Spooty/libreria** (playlist → MP3 → AVPlayer) — spec `docs/superpowers/specs/2026-11-07-mondrop-offline-spooty-sync-design.md`

## Interim (fino ad allora): key personale via `/mondrop/connect`

Mondrop → **Ottieni / Rinnova API key** → foglio `ASWebAuthenticationSession` su
`https://soundreel.casamon.dev/mondrop/connect` → login Authelia (cookie di sessione, forward-auth `auth-family`)
→ **Genera API key** → redirect `mondrop://auth?key=…&user=…&device=…`.

- Identità = `Remote-User` Authelia; la key è legata a utente + nome dispositivo (`config.apiKeys.meta`).
- `/api/share` e `/api/mondrop/*` usano l’utente della key e ignorano `user` del client (le key legacy restano com’erano).
- «Rinnova» (stesso utente + dispositivo) revoca la key precedente; max 8 key per utente.
- **Vincolo di sicurezza:** la rotta deve restare dietro Authelia. `soundreel-share` (`Path /api/share`) e
  `soundreel-mondrop` (`PathPrefix /api/mondrop`) bypassano Authelia: lì `Remote-User` lo scrive il client.
- Non sostituisce l’OIDC: niente refresh token, niente scadenza. Quando Geeko attiva l’IdP, la key resta fallback admin.
- Limite noto: la key torna all’app dentro uno schema URL custom (`mondrop://`), che iOS non garantisce univoco (un’altra app
  potrebbe registrarlo). Accettabile per la famiglia; OIDC con PKCE (code + exchange) lo chiude.
- Nessuna lista/revoca da UI: per revocare un dispositivo perso basta «Rinnova» con lo stesso nome dispositivo (o togliere la key da `config.apiKeys`).

Prima di questo: picker utente + key mintata a mano (`~/.config/soundreel/share-api-key`). Solo ponte.
