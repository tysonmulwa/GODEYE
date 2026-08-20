-- MFA recovery codes (ASVS 5.0 V2.8.4, NIST SP 800-63B §5.1.4.3).
--
-- Enabling MFA on this product had exactly one recovery path: the TOTP app on
-- the phone that enrolled it. A lost or wiped phone locked the owner out of a
-- workspace with a live subscription, connected social accounts and scheduled
-- posts still going out, and the only remedy was a manual UPDATE by whoever has
-- production database access. That is worse than the risk MFA was added for.
--
-- Expand-only: a new table, referenced by nothing the currently deployed
-- release reads. Rolling back the code leaves an unused table behind, which is
-- inert.
CREATE TABLE IF NOT EXISTS "MfaBackupCode" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    -- argon2id, never the code. A recovery code is a second password: it alone
    -- completes a sign-in, so it is stored the way the first one is. Anything
    -- reversible here would mean a database read is a full MFA bypass for every
    -- account at once.
    "codeHash"  TEXT NOT NULL,
    -- Single use. Set on redemption rather than deleting the row, so "somebody
    -- used a recovery code at 02:14" survives in the audit trail.
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaBackupCode_pkey" PRIMARY KEY ("id")
);

-- Sign-in reads every unused code for one user and verifies against each. The
-- index keeps that to the ten rows that can match rather than a scan that grows
-- with every account on the platform.
CREATE INDEX IF NOT EXISTS "MfaBackupCode_userId_usedAt_idx"
    ON "MfaBackupCode"("userId", "usedAt");

-- Deleting a user must take their codes. Without the cascade the rows outlive
-- the account, and a GDPR Art. 17 erasure leaves credentials behind.
ALTER TABLE "MfaBackupCode"
    ADD CONSTRAINT "MfaBackupCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
