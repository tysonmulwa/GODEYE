-- Tested down-path for 20260820120000_scalability_indexes.
--
-- The previous release reads scheduledPostId out of the `dimensions` JSON, which
-- this migration never removed, so dropping the column loses nothing: every
-- value in it was copied FROM that blob and the engine writes both.
DROP INDEX IF EXISTS "AnalyticsSnapshot_scheduledPostId_capturedAt_idx";
ALTER TABLE "AnalyticsSnapshot" DROP COLUMN IF EXISTS "scheduledPostId";
DROP INDEX IF EXISTS "ScheduledPost_orgId_status_scheduledAt_idx";
DROP INDEX IF EXISTS "ScheduledPost_contentItemId_idx";
