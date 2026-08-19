-- Tested down-path for 20260820090000_connection_expiry_states.
--
-- Postgres cannot remove a value from an enum, so the rollback moves any row
-- using a new state back to one the previous release understands, and drops the
-- index. The enum labels remain, unused and harmless.
--
-- EXPIRING_SOON -> ACTIVE, because that is what the old code called a
-- connection inside its refresh window. REVOKED -> DISCONNECTED, which is the
-- nearest thing the previous release had.
UPDATE "SocialConnection" SET "status" = 'ACTIVE' WHERE "status" = 'EXPIRING_SOON';
UPDATE "SocialConnection" SET "status" = 'DISCONNECTED' WHERE "status" = 'REVOKED';
DROP INDEX IF EXISTS "SocialConnection_status_expiresAt_idx";
