-- Migration 001: add search_vector column with GIN index and auto-update trigger

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

-- Backfill existing rows
UPDATE entries
SET search_vector = entries_build_search_vector(caption, results)
WHERE search_vector IS NULL;
