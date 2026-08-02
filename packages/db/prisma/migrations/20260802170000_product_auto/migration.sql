-- Re-read the shop on a schedule, so a new product does not wait for someone
-- to remember to press import.
ALTER TABLE "BusinessProfile" ADD COLUMN "productAutoImport" BOOLEAN NOT NULL DEFAULT false;

-- Posting from the catalogue is a separate decision from reading it: one is
-- far easier to undo than the other.
ALTER TABLE "BusinessProfile" ADD COLUMN "productAutoPost" BOOLEAN NOT NULL DEFAULT false;

-- Empty means nowhere, which is why auto-post cannot be switched on without
-- choosing a destination.
ALTER TABLE "BusinessProfile" ADD COLUMN "productPostPlatforms" "Platform"[] NOT NULL DEFAULT ARRAY[]::"Platform"[];
