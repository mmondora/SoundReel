-- SoundReel Postgres schema
-- Applied automatically by postgres container via /docker-entrypoint-initdb.d

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  input_channel TEXT NOT NULL,
  caption TEXT,
  thumbnail_url TEXT,
  media_url TEXT,
  status TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '{"songs":[],"films":[],"notes":[],"links":[],"tags":[],"summary":null}'::jsonb,
  action_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_user TEXT,
  owner_user TEXT NOT NULL DEFAULT 'mike'
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source_url ON entries (source_url);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries (status);

-- Migration: add input_user column (idempotent)
ALTER TABLE entries ADD COLUMN IF NOT EXISTS input_user TEXT;
CREATE INDEX IF NOT EXISTS idx_entries_input_user ON entries (input_user);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS owner_user TEXT;
UPDATE entries SET owner_user = 'mike' WHERE owner_user IS NULL OR owner_user = '';
ALTER TABLE entries ALTER COLUMN owner_user SET DEFAULT 'mike';
ALTER TABLE entries ALTER COLUMN owner_user SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_owner_created ON entries (owner_user, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_owner_url ON entries (owner_user, source_url);

CREATE TABLE IF NOT EXISTS entry_shares (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  shared_with TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, shared_with)
);
CREATE INDEX IF NOT EXISTS idx_entry_shares_with ON entry_shares (shared_with);

-- Search vector for FTS
ALTER TABLE entries ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_entries_search ON entries USING GIN(search_vector);

CREATE OR REPLACE FUNCTION entries_build_search_vector(
  p_caption TEXT,
  p_results JSONB
) RETURNS tsvector AS $$
DECLARE
  tags_text  TEXT;
  notes_text TEXT;
  songs_text TEXT;
  films_text TEXT;
  links_text TEXT;
BEGIN
  SELECT string_agg(value::text, ' ')
    INTO tags_text
    FROM jsonb_array_elements_text(COALESCE(p_results->'tags', '[]'::jsonb));

  SELECT string_agg(elem->>'text', ' ')
    INTO notes_text
    FROM jsonb_array_elements(COALESCE(p_results->'notes', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'title', '') || ' ' || COALESCE(elem->>'artist', ''), ' ')
    INTO songs_text
    FROM jsonb_array_elements(COALESCE(p_results->'songs', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'title', '') || ' ' || COALESCE(elem->>'director', ''), ' ')
    INTO films_text
    FROM jsonb_array_elements(COALESCE(p_results->'films', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'label', '') || ' ' || COALESCE(elem->>'domain', ''), ' ')
    INTO links_text
    FROM jsonb_array_elements(COALESCE(p_results->'links', '[]'::jsonb)) elem;

  RETURN
    setweight(to_tsvector('simple', COALESCE(p_caption, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'summary', '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(tags_text, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(notes_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(songs_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(films_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'transcription', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'visualContext', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'overlayText', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(links_text, '')), 'C');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION entries_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := entries_build_search_vector(NEW.caption, NEW.results);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_search_vector_update ON entries;
CREATE TRIGGER entries_search_vector_update
  BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_search_vector_trigger();

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level TEXT NOT NULL,
  category TEXT,
  entry_id TEXT,
  message TEXT NOT NULL,
  data JSONB
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_entry_id ON logs (entry_id);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);

-- NOTIFY on entry changes for SSE real-time stream
CREATE OR REPLACE FUNCTION notify_entry_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('entry_changed', json_build_object(
    'op', TG_OP,
    'id', COALESCE(NEW.id, OLD.id)
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_notify ON entries;
CREATE TRIGGER entries_notify
AFTER INSERT OR UPDATE OR DELETE ON entries
FOR EACH ROW EXECUTE FUNCTION notify_entry_changed();

-- Job queue: durable intake queue for Telegram-sourced URLs.
-- Instagram jobs are serialized one-at-a-time with jitter (ban avoidance);
-- other-platform jobs are capped at N concurrent by the worker.
CREATE TABLE IF NOT EXISTS job_queue (
  id SERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  source_url TEXT NOT NULL,
  platform TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  input_user TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repair/backfill runs re-queue old entries; they must not fire a Telegram
-- message for content the user submitted days ago.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS notify BOOLEAN NOT NULL DEFAULT TRUE;

-- Async transcription: a job is either the analysis pass or the deferred
-- Whisper run that feeds it. Existing rows are analysis jobs.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'analyze';

-- Backfilled history yields to anything the user just sent: claim orders by
-- priority first, so 10 always waits behind 0.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

-- A second analysis pass works from media the first pass already left on disk.
-- The flag means exactly one thing: do not fetch anything. It is set only by
-- dispatchTranscribe, never inferred from notify — a repair run is also silent,
-- and a repair exists precisely because the download failed, so it must still
-- be allowed to fetch.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS reanalyze BOOLEAN NOT NULL DEFAULT false;

-- Scarica e basta: l'analisi AI e' rimandata a una passata in blocco. Serve a
-- non svegliare ollama (KEEP_ALIVE 90s, un modello caricato per volta) una
-- volta ogni 40 minuti, con due cambi di modello per job.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS skip_ai BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_job_queue_dispatch ON job_queue (status, platform, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_job_queue_kind
  ON job_queue (kind, status, priority, next_attempt_at);

CREATE TABLE IF NOT EXISTS film_meta (
  film_key TEXT PRIMARY KEY,
  tmdb_id INTEGER,
  genres TEXT[] NOT NULL DEFAULT '{}',
  overview TEXT,
  film_cast TEXT[] NOT NULL DEFAULT '{}',
  tmdb_score NUMERIC(3,1),
  watched BOOLEAN NOT NULL DEFAULT false,
  rating TEXT CHECK (rating IN ('fresh','rotten')),
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  availability JSONB NOT NULL DEFAULT '{}'::jsonb,
  streaming_options JSONB,
  streaming_checked_at TIMESTAMPTZ,
  watchmode_title_id INTEGER,
  ia_identifier TEXT,
  ia_title TEXT,
  ia_year TEXT,
  ia_page_url TEXT,
  ia_file_url TEXT,
  ia_checked_at TIMESTAMPTZ,
  ia_downloaded_path TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS song_meta (
  song_key TEXT PRIMARY KEY,
  -- enrichment (written by pipeline/backfill only)
  deezer_id BIGINT,
  itunes_id BIGINT,
  genres TEXT[] NOT NULL DEFAULT '{}',
  album TEXT,
  cover_url TEXT,
  preview_url TEXT,
  deezer_url TEXT,
  itunes_url TEXT,
  enriched_at TIMESTAMPTZ,
  -- user state (written by PATCH only)
  listened BOOLEAN NOT NULL DEFAULT false,
  favorite BOOLEAN NOT NULL DEFAULT false,
  downloaded BOOLEAN NOT NULL DEFAULT false,
  rating TEXT CHECK (rating IN ('like','dislike')),
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user TEXT NOT NULL DEFAULT 'mike',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS owner_user TEXT;
UPDATE playlists SET owner_user = 'mike' WHERE owner_user IS NULL OR owner_user = '';
ALTER TABLE playlists ALTER COLUMN owner_user SET DEFAULT 'mike';
ALTER TABLE playlists ALTER COLUMN owner_user SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists (owner_user);

CREATE TABLE IF NOT EXISTS playlist_shares (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  shared_with TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playlist_id, shared_with)
);
CREATE INDEX IF NOT EXISTS idx_playlist_shares_with ON playlist_shares (shared_with);

CREATE TABLE IF NOT EXISTS user_config (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS telegram_identities (
  telegram_key TEXT PRIMARY KEY,
  owner_user TEXT NOT NULL,
  claimed_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telegram_identities_owner ON telegram_identities (owner_user);

CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_key TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, song_key)
);

CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_pos
  ON playlist_songs (playlist_id, position);

CREATE TABLE IF NOT EXISTS note_meta (
  note_key TEXT PRIMARY KEY,
  book_title TEXT,
  book_author TEXT,
  book_year INTEGER,
  cover_url TEXT,
  openlibrary_url TEXT,
  place_name TEXT,
  place_display_name TEXT,
  place_lat DOUBLE PRECISION,
  place_lon DOUBLE PRECISION,
  osm_url TEXT,
  enriched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spotify links tracked against Spooty (see migrations/015_spooty_requests.sql)
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

-- Per-song MP3 files + download queue, and the media server index (see migrations/016_song_files.sql)
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

-- Listening statistics, device audit and dynamic playlists (see migrations/017_listening_stats.sql)

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

-- Release year of a song (ADR-0013, migration 018): from the enrichment (Deezer album date, else iTunes), plus a
-- one-off background pass. `release_year_checked_at` is set even when no provider had a year, so a song is never
-- asked about twice.
ALTER TABLE song_meta ADD COLUMN IF NOT EXISTS release_year INTEGER CHECK (release_year BETWEEN 1900 AND 2100);
ALTER TABLE song_meta ADD COLUMN IF NOT EXISTS release_year_checked_at TIMESTAMPTZ;

-- ===== Mondrop inbox (migration 019, ADR-0015) =====
-- Mondrop inbox (ADR-0015, spec 2026-11-08-mondrop-share-inbox-design.md, contract docs/mondrop-inbox.md).
-- Idempotent like every migration here: the runner re-applies them at boot, so nothing below may run its
-- data changes twice (the backfill sits inside the "column is new" branch).

-- The notifications of a user: the outcome of his own shares and the notice that someone shared something with him.
-- The server is the source of truth, the app reads it; push is only the doorbell. Information expires after 3 days
-- (`expires_at`), errors never do (`expires_at` NULL). Removal is a soft delete (`removed_at`) so a second device can
-- be told what disappeared (`removedIds`); the daily sweep purges those rows after a week.
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- share_result (the outcome of one of MY shares) | share_received (somebody shared an entry with me)
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'error')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
  url TEXT,
  -- the entry's stored source_url: an error is closed by itself when the same link later succeeds
  link_key TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_user_visible
  ON inbox_items (user_id, created_at DESC) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_items_user_updated
  ON inbox_items (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_inbox_items_expiry
  ON inbox_items (expires_at) WHERE expires_at IS NOT NULL AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_items_error_link
  ON inbox_items (user_id, link_key) WHERE level = 'error' AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_items_entry
  ON inbox_items (entry_id) WHERE entry_id IS NOT NULL;

-- What a share asked for and has not finished yet: the playlist to fill and the family to tell. It makes the work
-- that depends on the analysis (songs into the playlist, the outcome, the recipients' notice) idempotent and
-- restart-safe, and lets an error carry the options it started with, so "Riprova" works from any device.
CREATE TABLE IF NOT EXISTS share_intents (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  -- the sender
  user_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  playlist_id TEXT,
  -- the valid recipients asked for (family users, never the sender)
  share_with TEXT[] NOT NULL DEFAULT '{}',
  -- the subset that did not have the entry yet: only those get a notice
  notify_with TEXT[] NOT NULL DEFAULT '{}',
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one open intent per entry and sender: sharing the same link twice before it is analysed is the same intent
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_intents_pending
  ON share_intents (entry_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_share_intents_entry ON share_intents (entry_id);

-- "Condivisioni ricevute": an entry shared with a user is "new" until he opens it. Everything shared before this
-- release counts as already seen, or the first launch would show the whole history as new.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'entry_shares' AND column_name = 'seen_at'
  ) THEN
    ALTER TABLE entry_shares ADD COLUMN seen_at TIMESTAMPTZ;
    UPDATE entry_shares SET seen_at = created_at;
  END IF;
END
$$;

-- Devices that asked to be rung (APNs). The token is the key: a phone handed to somebody else just re-registers.
-- Push stays off until the APNs key exists (ADR-0015); the table is harmless without it.
CREATE TABLE IF NOT EXISTS push_devices (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- a build installed from Xcode registers a development (sandbox) token
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  device TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices (user_id);

-- How the site is used (spec 2026-11-08-web-mobile-ux-design.md, M8): calls per day, user, kind of device (from the
-- user-agent, which is NOT stored), network and route group. Aggregated: no IP, no user-agent, no path, no query.
CREATE TABLE IF NOT EXISTS usage_counters (
  day DATE NOT NULL,
  user_id TEXT NOT NULL,
  -- mobile-web | desktop-web | app | automation | other
  device_class TEXT NOT NULL,
  -- internal | external
  network TEXT NOT NULL,
  route_group TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, device_class, network, route_group)
);

-- The lyrics of a song found on the Internet (ADR-0021; migration 020_song_lyrics.sql is the same table): a text found stays,
-- «not found» is remembered for 7 days (lyrics NULL), an instrumental has no text, an outage writes nothing.
CREATE TABLE IF NOT EXISTS song_lyrics (
  song_key TEXT PRIMARY KEY,
  lyrics TEXT,
  instrumental BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'lrclib',
  source_id TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Automatic playlists from the posts that talk about music (ADR-0023, spec 2026-11-10-auto-playlists-and-playlist-list-design.md).
-- Idempotent like every migration here: the runner re-applies them at boot. Additive: nothing existing changes meaning.
--
-- A playlist made by the server has `origin = 'auto'`. `auto_kind` says how: `one_off` = one playlist for one post (a precise
-- title: «Le 5 musiche di Natale»), `theme` = ONE playlist for a generic theme that every post of that theme feeds («Jazz da
-- ascoltare»). The unique indexes are what makes «una sola per tema» and «una per post» true even if two runs overlap.
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user';
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS auto_kind TEXT;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS theme_key TEXT;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS source_entry_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_playlists_theme ON playlists (owner_user, theme_key) WHERE theme_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_playlists_source_entry ON playlists (owner_user, source_entry_id) WHERE auto_kind = 'one_off';

-- Every entry the server has looked at, once per user: `done` (a playlist was made or fed), `skipped` (not a post about music, or the
-- theme was deleted by the user), `pending` (no good title yet: tried again), `waiting` (its theme has fewer than two songs). A re-analysis never duplicates anything.
CREATE TABLE IF NOT EXISTS auto_playlist_runs (
  entry_id TEXT NOT NULL,
  owner_user TEXT NOT NULL,
  status TEXT NOT NULL,
  playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  reason TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, owner_user)
);
-- `waiting` (ADR-0024): the post belongs to a theme that has fewer than two songs, so no playlist yet; `theme_key` says which theme.
ALTER TABLE auto_playlist_runs ADD COLUMN IF NOT EXISTS theme_key TEXT;
CREATE INDEX IF NOT EXISTS idx_auto_playlist_runs_waiting ON auto_playlist_runs (owner_user, theme_key) WHERE status = 'waiting';

-- The themes the server made a playlist for. A theme whose playlist is gone (`playlist_id` NULL) was DELETED by the user: it is
-- not made again.
CREATE TABLE IF NOT EXISTS auto_playlist_themes (
  owner_user TEXT NOT NULL,
  theme_key TEXT NOT NULL,
  title TEXT NOT NULL,
  playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user, theme_key)
);
