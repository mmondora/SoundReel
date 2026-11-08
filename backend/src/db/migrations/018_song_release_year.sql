-- Release year of a song (ADR-0013). Filled by the enrichment that already runs for every song (Deezer album
-- release_date, else iTunes releaseDate) and, once, by a throttled background pass over the songs already in the
-- library. The decade is derived (year / 10 * 10), never stored. Idempotent like every migration here.
ALTER TABLE song_meta ADD COLUMN IF NOT EXISTS release_year INTEGER CHECK (release_year BETWEEN 1900 AND 2100);

-- When a provider was last asked for the year. Set even when no provider had one, so the background pass
-- never asks about the same song twice.
ALTER TABLE song_meta ADD COLUMN IF NOT EXISTS release_year_checked_at TIMESTAMPTZ;
