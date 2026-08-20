-- Tested down-path for 20260820160000_mfa_backup_codes.
--
-- Destructive by nature, and that is the honest position: dropping this table
-- discards every unused recovery code. Anybody relying on one to get back into
-- their account can no longer do so, and there is no way to restore a code from
-- its hash.
--
-- So the rollback order matters. Roll the CODE back first and leave the table
-- in place -- it is inert to the previous release. Only run this if the table
-- itself has to go, and tell affected users to re-enrol first.
DROP INDEX IF EXISTS "MfaBackupCode_userId_usedAt_idx";
DROP TABLE IF EXISTS "MfaBackupCode";
