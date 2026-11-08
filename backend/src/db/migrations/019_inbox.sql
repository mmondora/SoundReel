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
