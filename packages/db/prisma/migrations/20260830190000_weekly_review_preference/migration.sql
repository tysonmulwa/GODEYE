-- The weekly review, and the switch that turns it off.
--
-- The preference column ships in the SAME migration as the feature, not after
-- it. A recurring digest with no way to stop it is spam however useful it is,
-- and "unsubscribe is coming" is how a sending domain ends up on a blocklist.
--
-- Default true: this is a summary of work the customer's own workspace did, and
-- is the kind of thing people expect from a tool that publishes on their behalf.
-- Anyone who disagrees turns it off in one click.
ALTER TABLE "Organization"
    ADD COLUMN IF NOT EXISTS "weeklyReview" BOOLEAN NOT NULL DEFAULT true;

-- The high-water mark. Without it a beat tick that fires twice, or a worker
-- that restarts mid-batch, sends the same summary again.
ALTER TABLE "Organization"
    ADD COLUMN IF NOT EXISTS "weeklyReviewAt" TIMESTAMP(3);

-- The scan is "orgs opted in whose last send was long enough ago", so it reads
-- exactly these two columns.
CREATE INDEX IF NOT EXISTS "Organization_weeklyReview_weeklyReviewAt_idx"
    ON "Organization"("weeklyReview", "weeklyReviewAt");
