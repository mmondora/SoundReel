CREATE TABLE IF NOT EXISTS software_meta (
  software_key TEXT PRIMARY KEY,
  description TEXT,
  published_at TIMESTAMPTZ,
  host TEXT,
  enriched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS software_meta_published_at_idx
  ON software_meta (published_at DESC NULLS LAST);
