-- Findings S-8 (payment idempotency race) and D-1 (missing index on the payment path).
--
-- Expand/contract: this migration only ADDS. The old dedup path reads AuditLog
-- and keeps working on the currently-deployed code, so an instance running the
-- previous release is unaffected while this rolls out.

-- D-1. The dedup query filtered on (action, "targetId"), neither of which was
-- indexed, on the highest-write table in the schema. CONCURRENTLY is
-- deliberately NOT used: Prisma runs migrations inside a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run in one. AuditLog is small enough today
-- that a brief lock is the lesser cost; revisit if it passes ~10M rows.
CREATE INDEX IF NOT EXISTS "AuditLog_action_targetId_idx" ON "AuditLog"("action", "targetId");

-- S-8. One row per payment acted on, with the constraint that makes a second
-- credit impossible rather than unlikely.
CREATE TABLE IF NOT EXISTS "PaymentApplication" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paystack',
    "reference" TEXT NOT NULL,
    "eventId" TEXT,
    "planCode" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "paidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentApplication_provider_reference_key"
    ON "PaymentApplication"("provider", "reference");

-- A retried webhook carries the same provider event id even when something else
-- about the payload differs. NULLs are distinct in Postgres, so providers that
-- send no event id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentApplication_provider_eventId_key"
    ON "PaymentApplication"("provider", "eventId");

CREATE INDEX IF NOT EXISTS "PaymentApplication_orgId_createdAt_idx"
    ON "PaymentApplication"("orgId", "createdAt");

ALTER TABLE "PaymentApplication"
    ADD CONSTRAINT "PaymentApplication_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the audit rows the old path wrote, so a payment already applied
-- before this deploy is not applied a second time by the new one. De-duplicated
-- on the way in, because the old path had no constraint and could have written
-- the same reference twice.
INSERT INTO "PaymentApplication" ("id", "orgId", "provider", "reference", "planCode", "mode", "createdAt")
SELECT DISTINCT ON (a."targetId")
       a."id",
       a."orgId",
       'paystack',
       a."targetId",
       COALESCE(a."metadata"->>'planCode', 'UNKNOWN'),
       COALESCE(a."metadata"->>'mode', 'once'),
       a."createdAt"
FROM "AuditLog" a
WHERE a."action" = 'billing.payment_applied'
  AND a."targetId" IS NOT NULL
  AND a."orgId" IS NOT NULL
ORDER BY a."targetId", a."createdAt" ASC
ON CONFLICT DO NOTHING;
