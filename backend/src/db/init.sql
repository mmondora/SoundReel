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
  input_user TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source_url ON entries (source_url);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries (status);

-- Migration: add input_user column (idempotent)
ALTER TABLE entries ADD COLUMN IF NOT EXISTS input_user TEXT;
CREATE INDEX IF NOT EXISTS idx_entries_input_user ON entries (input_user);

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
