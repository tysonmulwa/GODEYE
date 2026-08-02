-- Photo posts are rendered to video so they carry the workspace's track.
-- The length is now the user's choice: two photos held once came to six
-- seconds, which is not a post.
ALTER TABLE "BrandKit" ADD COLUMN "slideshowSeconds" INTEGER NOT NULL DEFAULT 30;

-- Whether photos become a Reel rather than a still carousel. Only ever
-- applies when a track is set, so a workspace without one is unaffected.
ALTER TABLE "BrandKit" ADD COLUMN "photosAsReels" BOOLEAN NOT NULL DEFAULT true;
