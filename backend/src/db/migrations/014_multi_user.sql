-- Multi-user (Authelia): owner + shares + per-user config.
-- Existing data → Michele (mike). Idempotent.

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

-- Telegram handle/id → Authelia owner (claimed by proper name).
CREATE TABLE IF NOT EXISTS telegram_identities (
  telegram_key TEXT PRIMARY KEY,
  owner_user TEXT NOT NULL,
  claimed_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telegram_identities_owner ON telegram_identities (owner_user);
