-- Findings S-10 (revocation lag), B-1 (refresh loses the active workspace),
-- S-15 (no refresh-token reuse detection), D-3 (refresh tokens accumulate).
--
-- Expand/contract: every column is nullable or defaulted, and nothing is
-- dropped, so the currently-deployed code keeps working unchanged while this
-- rolls out.

-- S-10. Bumped whenever a person's access to a workspace changes. The guard
-- compares it against the value in the token.
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- B-1. Which workspace the session was scoped to. Nullable because rows written
-- before this migration genuinely do not know, and guessing would be worse than
-- admitting it: those sessions fall back to the previous behaviour until they
-- rotate, which takes at most 15 minutes.
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "orgId" TEXT;

-- S-15. Tokens rotated from one original login share a family id.
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "familyId" TEXT;

CREATE INDEX IF NOT EXISTS "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- D-3. The retention sweep filters on these; without them it seq-scans a table
-- that grows by ~96 rows per active user per day.
CREATE INDEX IF NOT EXISTS "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX IF NOT EXISTS "RefreshToken_revokedAt_idx" ON "RefreshToken"("revokedAt");
