-- Drops two columns that no model declares and no code reads.
--
-- 20260802120000_slideshow_length put `slideshowSeconds` and `photosAsReels` on
-- BrandKit, i.e. per workspace. It failed in production and was never retried.
-- The very next migration, 20260802140000_post_length_per_post, moved the idea
-- to ContentItem and PostingPlan instead -- "per post rather than per
-- workspace: length is a creative choice that changes with the content, not a
-- setting you fix once", as schema.prisma still says.
--
-- So the old migration was superseded but left in the folder, still marked
-- failed. Repairing the ledger (2026-08-30) made `migrate deploy` retry it,
-- which succeeded and reintroduced the two columns -- now genuinely orphaned:
-- absent from schema.prisma, absent from the generated client, read by nothing.
--
-- Dropping them here rather than editing the old migration, so a database
-- rebuilt from scratch ends up in the same state as production instead of
-- diverging from it.
ALTER TABLE "BrandKit" DROP COLUMN IF EXISTS "slideshowSeconds";
ALTER TABLE "BrandKit" DROP COLUMN IF EXISTS "photosAsReels";
