-- Destructive: drops every outstanding reset link. Anyone mid-reset has to
-- start again, which is an inconvenience rather than a loss.
DROP TABLE IF EXISTS "PasswordResetToken";
