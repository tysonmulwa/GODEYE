-- Tested down-path for 20260821100000_tiktok_post_settings.
--
-- Dropping the column discards the creators' recorded choices for every
-- scheduled post that has not yet published. Those posts do not fail -- the
-- publisher reads NULL as "no consent recorded" and routes them to the TikTok
-- drafts inbox, where the creator makes the choices again inside TikTok.
--
-- So roll the CODE back first: the previous release ignores this column
-- entirely, which loses nothing. Only run this if the column itself has to go.
ALTER TABLE "ScheduledPost" DROP COLUMN IF EXISTS "tiktokSettings";
