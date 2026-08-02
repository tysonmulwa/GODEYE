-- Reading a catalogue off a website is opt-in. Recorded as who and when
-- rather than a flag, so it can be shown back and answered for.
ALTER TABLE "BusinessProfile" ADD COLUMN "productImportConsentAt" TIMESTAMP(3);
ALTER TABLE "BusinessProfile" ADD COLUMN "productImportConsentBy" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN "lastProductImportAt" TIMESTAMP(3);

CREATE TABLE "Product" (
    "id"           TEXT NOT NULL,
    "orgId"        TEXT NOT NULL,
    "sourceUrl"    TEXT NOT NULL,
    "title"        TEXT NOT NULL,
    "description"  TEXT,
    "price"        DECIMAL(14,2),
    "currency"     TEXT,
    "imageUrl"     TEXT,
    "availability" TEXT,
    "sku"          TEXT,
    "source"       TEXT NOT NULL,
    "contentHash"  TEXT NOT NULL,
    "firstSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPostedAt" TIMESTAMP(3),
    "postCount"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- A shop does not sell the same thing at two URLs, so a re-import updates
-- rather than duplicating.
CREATE UNIQUE INDEX "Product_orgId_sourceUrl_key" ON "Product"("orgId", "sourceUrl");
CREATE INDEX "Product_orgId_lastPostedAt_idx" ON "Product"("orgId", "lastPostedAt");

ALTER TABLE "Product" ADD CONSTRAINT "Product_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
