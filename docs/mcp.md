# SoundReel MCP (SecondBrain)

stdio MCP server that calls the running SoundReel HTTP API. No second database.

## Run

```bash
cd /home/mike/works/Soundreel/backend
SOUNDREEL_URL=http://127.0.0.1:8081 npm run mcp
```

Configured for Claude Code via:

- `/home/mike/works/Soundreel/.mcp.json`
- `/home/mike/works/personal/.mcp.json` (SecondBrain vault)

## Tools

| Tool | Notes |
|---|---|
| `soundreel_health` | `GET /health` |
| `soundreel_stats` | `GET /api/stats` |
| `soundreel_list_recent` | `GET /api/entries?view=summary` |
| `soundreel_get_entry` | `GET /api/entries/:id` |
| `soundreel_search` | `GET /api/search?q=` |
| `soundreel_analyze_url` | `POST /api/analyze` (channel=`mcp`, up to ~120s) |

## Auth / network

Loopback only (`127.0.0.1:8081`). Do not publish this MCP on the internet.
