-- The likes of the songs (ADR-0028, contract docs/mondrop-likes.md): «this song pleases me», of ONE person (the user of the Mondrop key), kept on the server.
-- Idempotent like every migration here: the runner re-applies them at boot. Additive: nothing existing changes meaning.
--
-- One row per person and song, and nothing else: no copy of the title (the song key is the identity everywhere: playlists, files, plays) and no
-- «dislike». The favorite, the like and the dislike of the SITE (`song_meta.favorite` / `rating`) are another thing: one value for the song, the same for
-- everybody (a leftover of the single-user period); they do not change.
CREATE TABLE IF NOT EXISTS song_likes (
  user_id TEXT NOT NULL,
  song_key TEXT NOT NULL,
  liked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, song_key)
);
CREATE INDEX IF NOT EXISTS idx_song_likes_user_time ON song_likes (user_id, liked_at DESC);
