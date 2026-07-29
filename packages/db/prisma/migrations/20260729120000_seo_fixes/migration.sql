-- CreateEnum
CREATE TYPE "FixChannel" AS ENUM ('FIX_PACK', 'CLOUDFLARE', 'WORDPRESS', 'SHOPIFY', 'GITHUB');

-- CreateEnum
CREATE TYPE "FixStatus" AS ENUM ('PROPOSED', 'APPLIED', 'VERIFIED', 'FAILED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FixKind" AS ENUM ('HEAD_TAG', 'FILE', 'ATTRIBUTE', 'MANUAL');

-- AlterTable
ALTER TABLE "SeoAudit" ADD COLUMN "platform" TEXT;

-- CreateTable
CREATE TABLE "SeoFix" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "findingCode" TEXT NOT NULL,
    "kind" "FixKind" NOT NULL,
    "channel" "FixChannel" NOT NULL DEFAULT 'FIX_PACK',
    "status" "FixStatus" NOT NULL DEFAULT 'PROPOSED',
    "severity" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "filePath" TEXT,
    "guidance" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoFix_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoFix_orgId_status_idx" ON "SeoFix"("orgId", "status");

-- CreateIndex
CREATE INDEX "SeoFix_auditId_idx" ON "SeoFix"("auditId");

-- AddForeignKey
ALTER TABLE "SeoFix" ADD CONSTRAINT "SeoFix_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoFix" ADD CONSTRAINT "SeoFix_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SeoAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Project convention: RLS enabled on every table with no policies (Prisma connects
-- as the table owner and is unaffected; the Supabase anon-key REST API is locked out).
ALTER TABLE "SeoFix" ENABLE ROW LEVEL SECURITY;
