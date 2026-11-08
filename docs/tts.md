# SoundReel TTS render

Delegated voice synthesis via gpu-router pool (scelta B).

## Env

```
TTS_URL=http://gpu-router:9000/tts   # host: http://127.0.0.1:9001/tts
```

## API

```
POST /api/tts/render
{
  "text": "...",
  "voice": "it-IT-DiegoNeural",   // optional
  "speed": 1.0,                   // optional
  "localOnly": false,             // true → X-TTS-Local-Only: 1 (503 until local backend)
  "async": false,                 // true → 202 + jobId
  "bookKey": "...",               // optional metadata
  "chapterId": "..."
}
→ { status: "ready", audioUrl: "/media/tts/<hash>.mp3", durationSec, hash, cached, ... }

GET /api/tts/jobs/:id
GET|PUT /api/reading-progress/:itemKey
```

Cache files: `MEDIA_ROOT/tts/<hash>.mp3` (+ `.json` meta). Served as `/media/tts/<hash>.mp3`.

Production `/player` UI is **not** wired yet — API only.
