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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source_url ON entries (source_url);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries (status);

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
