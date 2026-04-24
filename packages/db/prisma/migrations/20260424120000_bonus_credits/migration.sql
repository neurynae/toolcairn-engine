-- Add one-time bonus credit pool to User.
-- Default 100 — every existing user gets the initial grant on migration;
-- new users get it automatically via @default(100).
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "bonusCreditRemaining" INTEGER NOT NULL DEFAULT 100;
