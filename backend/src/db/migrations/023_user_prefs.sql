-- The configuration of the site, one small document per user (ADR-0026, spec 2026-11-10-web-look-and-feel-rethink-design.md §3.3).
-- Michele, 10 November: «configurazione per utente - di default vista A».
-- Idempotent like every migration here: the runner re-applies them at boot. Additive: nothing existing changes meaning.
--
-- `user_id` is the Authelia user of the request (`Remote-User`): mike, archi, sara. `prefs` keeps ONLY what the user chose
-- (a sparse document); the defaults are filled in by the server when the document is read, so a default can change in one place.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
