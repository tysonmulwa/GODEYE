-- Restores the two superseded columns with their original defaults.
--
-- This down-path exists for symmetry and is very unlikely to be wanted: the
-- columns hold no data any code has ever written, so rolling forward again
-- loses nothing. If you are running this, you probably want
-- 20260802140000_post_length_per_post instead, which is where these settings
-- actually live.
ALTER TABLE "BrandKit" ADD COLUMN IF NOT EXISTS "slideshowSeconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "BrandKit" ADD COLUMN IF NOT EXISTS "photosAsReels" BOOLEAN NOT NULL DEFAULT true;
