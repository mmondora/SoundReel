-- The collections of the library (ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md §8): what a post is about, read from its
-- text by local models, and the groups of posts that talk about the same thing. Site only (Michele, Q2: nothing for Mondrop).
-- Idempotent like every migration here: the runner re-applies them at boot. Additive: nothing existing changes meaning.
--
-- Everything in these tables is DERIVED and can be rebuilt (the vectors, the places and venues read from the text, the groups), EXCEPT the
-- corrections of the user, which survive every recompute: a renamed collection (`collections.name_by = 'user'`), a hidden one
-- (`state = 'hidden'`), one merged into another (`state = 'merged'`, and then `parent_id` is the collection it went into), and the entries put
-- in or taken out by hand (`collection_entries.source` = 'user_add' / 'user_remove'). No pgvector (ADR-0001): vectors are REAL[], compared in
-- memory. No coordinates anywhere: the link to Google Maps starts from the name of a place and is built by the server.
-- Types (`type:*`) and places (`place:*`) have no rows here: the API computes them.

-- One vector per entry, made again only when the text (its hash) or the model changes.
CREATE TABLE IF NOT EXISTS entry_vectors (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vector REAL[] NOT NULL,
  text_hash TEXT NOT NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The places an entry names (city, region or country), clean names that the text really contains: no coordinates.
CREATE TABLE IF NOT EXISTS entry_places (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  place TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('city', 'region', 'country')),
  PRIMARY KEY (entry_id, place)
);
CREATE INDEX IF NOT EXISTS idx_entry_places_place ON entry_places (place);

-- The venues an entry names (restaurant, bar, hotel…). `venue_key` = the cleaned name, a bar, the cleaned city: the same venue in two posts has
-- the same key (one thing = one row for the reader, ADR-0017; here one row per post, the view makes one of them).
CREATE TABLE IF NOT EXISTS entry_venues (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  venue_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  place TEXT,
  PRIMARY KEY (entry_id, venue_key)
);
CREATE INDEX IF NOT EXISTS idx_entry_venues_key ON entry_venues (venue_key);

-- The record that the places and the venues of an entry were looked for in a text (`text_hash` = the fingerprint of what was read). One row even
-- when nothing was found: the posts without a place (most of them) are not asked again by the next pass or the next backfill. A reading that
-- failed leaves no row and is tried again; a post whose text changed has another hash and is read again.
CREATE TABLE IF NOT EXISTS entry_place_runs (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  text_hash TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The themes found (and their children). `group_label` is the heading of the seed list (NULL = «Altre»). `state`: `watching` (3-4 entries, not
-- shown), `active`, `hidden` (by the user), `merged` (by the user, into `parent_id`). `size` is the number of live members at the last save.
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  owner_user TEXT NOT NULL,
  name TEXT NOT NULL,
  name_by TEXT NOT NULL DEFAULT 'auto' CHECK (name_by IN ('auto', 'user')),
  group_label TEXT,
  parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  state TEXT NOT NULL DEFAULT 'watching' CHECK (state IN ('watching', 'active', 'hidden', 'merged')),
  origin TEXT NOT NULL DEFAULT 'found' CHECK (origin IN ('seed', 'found', 'manual')),
  centroid REAL[],
  size INTEGER NOT NULL DEFAULT 0,
  coherence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections (owner_user, state);
CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections (parent_id);

-- Who is in which collection. `source`: `auto` (found by the grouping, replaced at each pass), `user_add` (put in by hand: never leaves),
-- `user_remove` (taken out by hand: it REMEMBERS the entry, which never comes back).
CREATE TABLE IF NOT EXISTS collection_entries (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  score REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'user_add', 'user_remove')),
  PRIMARY KEY (collection_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_entries_entry ON collection_entries (entry_id);
CREATE INDEX IF NOT EXISTS idx_collection_entries_user ON collection_entries (collection_id) WHERE source <> 'auto';
