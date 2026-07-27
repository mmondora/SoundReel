CREATE TABLE IF NOT EXISTS note_meta (
  note_key TEXT PRIMARY KEY,
  book_title TEXT,
  book_author TEXT,
  book_year INTEGER,
  cover_url TEXT,
  openlibrary_url TEXT,
  enriched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
