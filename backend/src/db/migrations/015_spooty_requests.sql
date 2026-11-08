-- Spotify links ingested through any channel (Telegram, Mondrop share, web) and
-- tracked against Spooty until the download finishes. One row per journal entry.
-- Idempotent like every migration here: the runner re-applies them at boot.
CREATE TABLE IF NOT EXISTS spooty_requests (
  id SERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  owner_user TEXT NOT NULL DEFAULT 'mike',
  -- canonical https://open.spotify.com/<track|album|playlist>/<id>
  spotify_url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'track',
  -- NULL until Spooty accepted the link and we found its playlist
  spooty_playlist_id INTEGER,
  -- Telegram chat to notify on completion/failure (NULL for share/web)
  chat_id BIGINT,
  -- queued (not yet accepted by Spooty) | tracking | completed | failed
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id)
);

CREATE INDEX IF NOT EXISTS idx_spooty_requests_due
  ON spooty_requests (status, next_check_at);
