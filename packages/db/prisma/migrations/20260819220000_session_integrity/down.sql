-- Tested down-path for 20260819220000_session_integrity.
--
-- Dropping these columns returns the system to the pre-fix behaviour: sessions
-- stop being scoped to a workspace, revocation goes back to waiting out the
-- 15-minute access token, and refresh-token theft becomes invisible again.
-- Every live session survives the rollback; only the extra guarantees are lost.
DROP INDEX IF EXISTS "RefreshToken_revokedAt_idx";
DROP INDEX IF EXISTS "RefreshToken_expiresAt_idx";
DROP INDEX IF EXISTS "RefreshToken_familyId_idx";
ALTER TABLE "RefreshToken" DROP COLUMN IF EXISTS "familyId";
ALTER TABLE "RefreshToken" DROP COLUMN IF EXISTS "orgId";
ALTER TABLE "Membership" DROP COLUMN IF EXISTS "sessionVersion";
