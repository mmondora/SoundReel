-- A second analysis pass works from media the first pass already left on disk.
-- The flag means exactly one thing: do not fetch anything. It is set only by
-- dispatchTranscribe.
--
-- It exists as its own column because the worker used to infer it from
-- notify = false, which is also what a repair run carries. That conflated
-- "merge instead of replace" with "never fetch", and silently turned
-- requeueErrors into a no-op: a repair exists precisely because the download
-- failed, so there is nothing on disk to work from.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS reanalyze BOOLEAN NOT NULL DEFAULT false;
