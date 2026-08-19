-- Finding B-7: platform tokens expire and were never refreshed.
--
-- SocialConnection.expiresAt was written in four places and read in NONE, and
-- the beat schedule had no refresh task. TikTok access tokens live 24 hours, so
-- every TikTok connection stopped working a day after it was made while the UI
-- still showed ACTIVE. Instagram and LinkedIn died at ~60 days, silently.
--
-- Two new states, so a connection can say what is actually wrong with it.
-- Expand-only: nothing reads these yet on the currently-deployed release, and
-- an unknown enum value is never written to a column the old code updates.
ALTER TYPE "ConnectionStatus" ADD VALUE IF NOT EXISTS 'EXPIRING_SOON';
ALTER TYPE "ConnectionStatus" ADD VALUE IF NOT EXISTS 'REVOKED';

-- The refresh sweep selects on (status, expiresAt) every hour.
CREATE INDEX IF NOT EXISTS "SocialConnection_status_expiresAt_idx"
    ON "SocialConnection"("status", "expiresAt");
