# SoundReel MCP → SecondBrain (2026-11-07)

Stato: **MVP implementato**.

## Contesto

- **SecondBrain** = vault `~/works/personal`
- MCP stdio → Fastify HTTP (`SOUNDREEL_URL`, default `http://127.0.0.1:8081`)
- Entry: `backend/src/mcp/server.ts` (`npm run mcp` in `backend/`)
- Client config: `Soundreel/.mcp.json` e `personal/.mcp.json`

## Tools

| Tool | Mutazione | API |
|---|---|---|
| `soundreel_health` | no | `GET /health` |
| `soundreel_stats` | no | `GET /api/stats` |
| `soundreel_list_recent` | no | `GET /api/entries?view=summary` |
| `soundreel_get_entry` | no | `GET /api/entries/:id` |
| `soundreel_search` | no | `GET /api/search` |
| `soundreel_analyze_url` | sì | `POST /api/analyze` channel=`mcp` |

Doc operativa: `docs/mcp.md`.
