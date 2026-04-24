-- Bonus credit expiry + referral loop.
-- Credits expire 90 days after grant (backfilled for existing users from
-- createdAt + 90d so nobody loses credits they already had).

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "bonusCreditExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "referredByUserId"     TEXT;

-- Backfill: existing users get 90 days from today (not from createdAt) so the
-- first wave of accounts doesn't lose their bonus pool retroactively.
UPDATE "User"
  SET "bonusCreditExpiresAt" = NOW() + INTERVAL '90 days'
  WHERE "bonusCreditExpiresAt" IS NULL;

DO $$ BEGIN
  ALTER TABLE "User"
    ADD CONSTRAINT "User_referredByUserId_fkey"
    FOREIGN KEY ("referredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "User_referredByUserId_idx" ON "User"("referredByUserId");

-- ─── ReferralGrant: one row per (inviter, invitee) pair ───────────────────
CREATE TABLE IF NOT EXISTS "ReferralGrant" (
  "id"            TEXT         NOT NULL,
  "inviterUserId" TEXT         NOT NULL,
  "inviteeUserId" TEXT         NOT NULL,
  "inviterBonus"  INTEGER      NOT NULL DEFAULT 50,
  "inviteeBonus"  INTEGER      NOT NULL DEFAULT 50,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralGrant_inviter_invitee_key"
  ON "ReferralGrant"("inviterUserId","inviteeUserId");
CREATE INDEX IF NOT EXISTS "ReferralGrant_inviterUserId_idx"
  ON "ReferralGrant"("inviterUserId");

DO $$ BEGIN
  ALTER TABLE "ReferralGrant"
    ADD CONSTRAINT "ReferralGrant_inviter_fkey"
    FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ReferralGrant"
    ADD CONSTRAINT "ReferralGrant_invitee_fkey"
    FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
