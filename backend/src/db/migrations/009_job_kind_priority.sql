-- Async transcription: a job is either the analysis pass or the deferred
-- Whisper run that feeds it. Existing rows are analysis jobs.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'analyze';

-- Backfilled history yields to anything the user just sent: claim orders by
-- priority first, so 10 always waits behind 0.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_job_queue_kind
  ON job_queue (kind, status, priority, next_attempt_at);
