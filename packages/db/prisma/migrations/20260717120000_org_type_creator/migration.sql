-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('BUSINESS', 'CREATOR');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "type" "OrgType" NOT NULL DEFAULT 'BUSINESS';
