-- Automatic playlists: a playlist has at least two songs (ADR-0024, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.11).
-- Michele, 10 November: «le playlist non possono essere di una sola canzone - vanno smontate».
-- Idempotent like every migration here: the runner re-applies them at boot. Additive: nothing existing changes meaning.
--
-- A post of a theme that has fewer than two songs is `waiting` (its run has status 'waiting') for that theme; `theme_key` says which one, so
-- the post that makes the second song finds the others and the playlist is born with all of them.
ALTER TABLE auto_playlist_runs ADD COLUMN IF NOT EXISTS theme_key TEXT;
CREATE INDEX IF NOT EXISTS idx_auto_playlist_runs_waiting ON auto_playlist_runs (owner_user, theme_key) WHERE status = 'waiting';
