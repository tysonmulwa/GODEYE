-- Length is a creative choice that changes with the content, so it belongs to
-- the post rather than the workspace. renderAsVideo replaces photosAsReels and
-- reads as what it does: TikTok's API takes no still post that can carry
-- audio, so it always renders; everywhere else a carousel is a real choice.
ALTER TABLE "ContentItem" ADD COLUMN "slideshowSeconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "ContentItem" ADD COLUMN "renderAsVideo" BOOLEAN NOT NULL DEFAULT true;

-- Autopilot posts inherit the plan's choice.
ALTER TABLE "PostingPlan" ADD COLUMN "slideshowSeconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "PostingPlan" ADD COLUMN "renderAsVideo" BOOLEAN NOT NULL DEFAULT true;

-- Both workspaces still held the defaults, so nothing chosen is being
-- discarded. Dropped rather than left in place: two sources of truth for the
-- same decision is how a setting silently stops taking effect.
ALTER TABLE "BrandKit" DROP COLUMN "slideshowSeconds";
ALTER TABLE "BrandKit" DROP COLUMN "photosAsReels";
