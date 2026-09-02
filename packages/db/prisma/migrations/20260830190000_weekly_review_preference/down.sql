-- Destructive: forgets who had turned the weekly review off. Re-applying the
-- forward migration would then default them all back to receiving it, which is
-- exactly the thing the column exists to prevent. Restore the values from a
-- backup rather than assuming the default.
DROP INDEX IF EXISTS "Organization_weeklyReview_weeklyReviewAt_idx";
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "weeklyReviewAt";
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "weeklyReview";
