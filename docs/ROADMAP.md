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
