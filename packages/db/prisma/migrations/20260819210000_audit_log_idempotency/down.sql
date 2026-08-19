-- Tested down-path for 20260819210000_audit_log_idempotency.
--
-- Safe to run against the previous release: that code reads AuditLog for
-- payment dedup and never touches PaymentApplication, so dropping this table
-- returns the system to exactly the behaviour it had before — including the
-- S-8 race, which is the point of a down-path being honest about what it undoes.
--
-- The AuditLog rows the old path wrote were never deleted, so no payment
-- history is lost by rolling back.
DROP TABLE IF EXISTS "PaymentApplication";
DROP INDEX IF EXISTS "AuditLog_action_targetId_idx";
