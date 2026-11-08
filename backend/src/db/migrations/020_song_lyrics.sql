-- The lyrics of a song found on the Internet (ADR-0021, spec 2026-11-08-lyrics-from-the-internet-design.md).
-- Idempotent like every migration here: the runner re-applies them at boot.
--
-- One row per song KEY that was looked for. A text found stays (`lyrics` set); «not found» is remembered for 7 days
-- (`lyrics` NULL, `checked_at` says when); a song the archive calls instrumental has `instrumental` true and no text.
-- An outage of the archive writes nothing: it is not an answer. The transcript of a post is NOT kept here (it lives in the
-- entry); this table holds only what came from outside.
CREATE TABLE IF NOT EXISTS song_lyrics (
  song_key TEXT PRIMARY KEY,
  lyrics TEXT,
  instrumental BOOLEAN NOT NULL DEFAULT false,
  -- where the text came from (today only lrclib) and its id there
  source TEXT NOT NULL DEFAULT 'lrclib',
  source_id TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
