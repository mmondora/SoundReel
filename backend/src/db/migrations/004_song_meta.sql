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
