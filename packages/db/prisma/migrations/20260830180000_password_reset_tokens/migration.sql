-- Single-use password reset links.
--
-- Only the SHA-256 of the token is stored: the plaintext lives in exactly one
-- place, the email that was sent, so a dump of this table cannot reset anyone's
-- password.
--
-- Expand-only. Nothing reads this table until the endpoints ship, so it is safe
-- to apply before the code that uses it.
CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key"
    ON "PasswordResetToken"("tokenHash");
-- Finding the caller's outstanding tokens, to invalidate them on a new request.
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_usedAt_idx"
    ON "PasswordResetToken"("userId", "usedAt");
-- The retention sweep.
CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx"
    ON "PasswordResetToken"("expiresAt");

ALTER TABLE "PasswordResetToken"
    ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
