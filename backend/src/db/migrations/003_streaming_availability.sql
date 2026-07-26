-- Migration 003: streaming availability data on film_meta

ALTER TABLE film_meta
  ADD COLUMN IF NOT EXISTS streaming_options JSONB,
  ADD COLUMN IF NOT EXISTS streaming_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS watchmode_title_id INTEGER;
