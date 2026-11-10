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
-- theme was deleted by the user), `pending` (no good title yet: tried again). A re-analysis never duplicates anything.
CREATE TABLE IF NOT EXISTS auto_playlist_runs (
  entry_id TEXT NOT NULL,
  owner_user TEXT NOT NULL,
  status TEXT NOT NULL,
  playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  reason TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, owner_user)
);

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
