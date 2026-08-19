-- Findings D-4 (unbounded A/B report) and D-7 (missing indexes on hot paths),
-- plus the index the per-tenant fairness ranking needs.
--
-- Expand-only. Adding a column and four indexes changes nothing the currently
-- deployed release reads, and the backfill below is idempotent.

-- D-7. Every one of these is a filter a customer-facing page performs today.
CREATE INDEX IF NOT EXISTS "ScheduledPost_contentItemId_idx"
    ON "ScheduledPost"("contentItemId");

-- The dispatcher ranks due posts per workspace so one busy tenant cannot
-- starve the rest. Without this the window function sorts the whole due set
-- on every 30-second tick.
CREATE INDEX IF NOT EXISTS "ScheduledPost_orgId_status_scheduledAt_idx"
    ON "ScheduledPost"("orgId", "status", "scheduledAt");

-- D-4. The A/B report needs the LATEST engagement measurement per scheduled
-- post. That id lived inside the `dimensions` JSON blob, so the query could not
-- filter on it and loaded the org's entire history instead.
ALTER TABLE "AnalyticsSnapshot" ADD COLUMN IF NOT EXISTS "scheduledPostId" TEXT;

-- Backfill from where it has been living. `->>` on a NULL column yields NULL,
-- so rows that never carried one are simply left alone.
UPDATE "AnalyticsSnapshot"
SET "scheduledPostId" = "dimensions"->>'scheduledPostId'
WHERE "scheduledPostId" IS NULL
  AND "dimensions" IS NOT NULL
  AND "dimensions"->>'scheduledPostId' IS NOT NULL;

-- DESC on capturedAt because every read of this index wants the most recent
-- measurement first: DISTINCT ON ("scheduledPostId") ORDER BY "capturedAt" DESC.
CREATE INDEX IF NOT EXISTS "AnalyticsSnapshot_scheduledPostId_capturedAt_idx"
    ON "AnalyticsSnapshot"("scheduledPostId", "capturedAt" DESC);
