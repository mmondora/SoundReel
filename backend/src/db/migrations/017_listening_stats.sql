-- Listening statistics, the audit of what devices do to themselves, and dynamic playlists.
-- Idempotent like every migration here: the runner re-applies them at boot.

-- One row per listening session reported by a client (Mondrop, web player). Raw facts only: the server decides
-- what "counts" as a play, so the rule can change without updating the apps. The primary key includes the user
-- so two users can never collide on a client-generated id; resending an event is a no-op.
CREATE TABLE IF NOT EXISTS play_events (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  song_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  -- started_at shifted by the device's UTC offset at play time, as a plain timestamp: the hour and weekday a
  -- person actually heard it ("7 to 8 in the morning"), whatever the server's own timezone.
  local_started_at TIMESTAMP NOT NULL,
  tz_offset_min INTEGER NOT NULL DEFAULT 0,
  listened_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  completed BOOLEAN NOT NULL DEFAULT false,
  -- local (file on the phone) | stream | web
  origin TEXT NOT NULL DEFAULT 'local',
  playlist_id TEXT,
  -- listened >= min(30 s, 50 % of the duration); the rest are skips
  counted BOOLEAN NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_play_events_user_time ON play_events (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_events_song ON play_events (song_key);
CREATE INDEX IF NOT EXISTS idx_play_events_counted_local ON play_events (counted, local_started_at);

-- Durable audit of actions a device performs on itself (today: deleting downloaded songs). Unlike `logs`,
-- the console's "clear logs" never touches it.
CREATE TABLE IF NOT EXISTS device_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  at TIMESTAMPTZ NOT NULL,
  user_id TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  details JSONB NOT NULL,
  event_id TEXT NOT NULL,
  UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_device_events_user_ts ON device_events (user_id, ts DESC);

-- Dynamic playlists: a rule instead of a list of songs (`rule` is the JSON documented in docs/mondrop-stats.md).
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'static';
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS rule JSONB;

-- Where a song's file sits on the media server (volume-relative path). Set when the file was COPIED FROM the box
-- (its original, no duplicate is ever mirrored back); otherwise the replica path is derived from rel_path.
ALTER TABLE song_files ADD COLUMN IF NOT EXISTS media_rel_path TEXT;
