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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
