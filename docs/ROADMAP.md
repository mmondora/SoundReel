# Soundreel — Roadmap / TODO

## In considerazione

### Migrazione enrichment: OpenAI → Perplexity Sonar
**File:** `backend/src/services/openaiEnrich.ts`

Sostituire `gpt-4o-mini` + `web_search_preview` (OpenAI Responses API) con Perplexity `sonar`.

**Motivazione:** web search built-in, più economico, chiave già presente in `~/.perplexity-api-key`, stesso ecosistema di signal-brief.

**Diff tecnico:**
- Endpoint: `https://api.openai.com/v1/responses` → `https://api.perplexity.ai/chat/completions`
- Formato: Responses API → Chat Completions standard (`messages` array)
- Rimuovere `tools: [{ type: 'web_search_preview' }]`
- Modello: `gpt-4o-mini` → `sonar` / `sonar-pro`
- Parsing: `data.output[].content[].text` → `data.choices[0].message.content`
- Chiave: sorgente separata da OpenAI config (env o DB)
- Update Settings UI per gestire chiave Perplexity

**Stima:** ~40 righe `openaiEnrich.ts` + Settings UI

### X (Twitter) — analizzare link post come IG / TikTok

Aprire/analizzare URL `x.com` / `twitter.com` (caption + media) con qualità paragonabile a Instagram/TikTok, da web/Telegram/Share. Oggi: platform già `twitter` + OG/page extract; da rafforzare il percorso media (video/audio) per Shazam/Whisper/vision. Dettaglio in `ROADMAP.md` (root).

### Client iOS / Mondrop — playlist sync locale + play offline (Spooty)

Sync playlist → MP3 offline + player in Mondrop. Libreria prima, se manca accoda Spooty. **Bloccato su OIDC Authelia (Geeko)**. Spec: `docs/superpowers/specs/2026-11-07-mondrop-offline-spooty-sync-design.md`.