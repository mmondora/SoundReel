# Spike TTS (2026-11-07)

## Fatto

1. **CLI locale:** `demo-ch04.mp3` (~30s) via edge-tts DiegoNeural  
2. **UI:** http://127.0.0.1:8081/designs/player-hub/reader-tts.html  
3. **Geeko (scelta B):** pool `tts` su gpu-router + `edge-tts-adapter`  
4. **SoundReel render API:** `POST /api/tts/render`, `GET /api/tts/jobs/:id`, reading-progress  
   - `TTS_URL=http://gpu-router:9000/tts`  
   - Cache: `/data/media/tts/<hash>.mp3` → `/media/tts/<hash>.mp3`  
   - Privati: `localOnly: true` → header `X-TTS-Local-Only: 1` (503 finché non c’è backend locale)

## MCP SecondBrain

- `backend/src/mcp/server.ts` + `.mcp.json` in SoundReel e `~/works/personal`  
- Doc: `docs/mcp.md`

## Non fatto (voluto)

- Wiring UI su `/player` di produzione  
- Backend TTS locale nel pool (ascolto campioni prima)
