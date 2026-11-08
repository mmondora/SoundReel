-- One row per song: where its MP3 lives and, until it exists, the download job that will
-- produce it (status drives the queue, so there is exactly one job per song).
-- Idempotent like every migration here: the runner re-applies them at boot.
CREATE TABLE IF NOT EXISTS song_files (
  song_key TEXT PRIMARY KEY,
  -- queued | downloading | ready | failed | no_source
  status TEXT NOT NULL DEFAULT 'queued',
  -- library (Spooty file) | ytdlp | existing (copied from the media server)
  source TEXT,
  -- relative to MUSIC_LIBRARY_PATH (/music); store files live under SoundReel/
  rel_path TEXT,
  bytes BIGINT,
  mtime_ms BIGINT,
  duration_s INTEGER,
  -- how the file was found: name | index | search | override
  match TEXT,
  video_id TEXT,
  -- user-supplied YouTube URL that wins over the search
  video_url_override TEXT,
  -- direct URL on the media server, only once the replica was verified there
  media_url TEXT,
  published_at TIMESTAMPTZ,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- 10 = somebody is waiting for it (first play), 0 = playlist sync
  priority INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  requested_by TEXT,
  -- metadata snapshot taken at request time, so the worker never re-aggregates the journal
  artist TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  album TEXT,
  cover_url TEXT,
  expected_duration_s INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_song_files_queue
  ON song_files (status, priority DESC, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_song_files_unpublished
  ON song_files (status) WHERE published_at IS NULL;

-- Copy of the media server's own index (DLNA ContentDirectory), so matching a song
-- never needs a live scan of the share. Refreshed periodically by the backend.
CREATE TABLE IF NOT EXISTS media_index (
  store TEXT NOT NULL,
  -- path relative to the volume, exactly as the media server's URL carries it
  rel_path TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  album TEXT,
  duration_s INTEGER,
  bytes BIGINT,
  -- normalized "artist|title" for lookups
  norm_key TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_media_index_norm ON media_index (norm_key);
