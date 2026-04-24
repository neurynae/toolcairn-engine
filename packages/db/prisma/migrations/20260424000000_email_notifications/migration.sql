-- Email notification service: outbox + event audit + suppression + scheduled + magic links + mcp releases + waitlist
-- All new columns nullable or defaulted — no backfill required.

-- ─── User: notification preferences ─────────────────────────────────────────
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "emailWelcomeSent"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notifyLimitAlerts" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notifyReleases"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notifyBilling"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "emailDoNotEmail"   BOOLEAN NOT NULL DEFAULT false;

-- ─── EmailOutbox: transactional outbox, drained into Redis by 1s poller ────
CREATE TABLE IF NOT EXISTS "EmailOutbox" (
  "id"          TEXT        NOT NULL,
  "kind"        TEXT        NOT NULL,
  "userId"      TEXT,
  "toEmail"     TEXT        NOT NULL,
  "scopeKey"    TEXT        NOT NULL DEFAULT '',
  "payload"     JSONB       NOT NULL,
  "requestId"   TEXT,
  "scheduledAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "attempts"    INTEGER     NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EmailOutbox_processedAt_scheduledAt_idx" ON "EmailOutbox"("processedAt","scheduledAt");
CREATE INDEX IF NOT EXISTS "EmailOutbox_userId_kind_idx"             ON "EmailOutbox"("userId","kind");

-- ─── EmailEvent: idempotency + delivery-state system of record ─────────────
CREATE TABLE IF NOT EXISTS "EmailEvent" (
  "id"                TEXT         NOT NULL,
  "userId"            TEXT,
  "toEmail"           TEXT         NOT NULL,
  "kind"              TEXT         NOT NULL,
  "scopeKey"          TEXT         NOT NULL DEFAULT '',
  "requestId"         TEXT,
  "outboxId"          TEXT,
  "providerMessageId" TEXT,
  "status"            TEXT         NOT NULL DEFAULT 'queued',
  "attempts"          INTEGER      NOT NULL DEFAULT 0,
  "errorCode"         TEXT,
  "errorMessage"      TEXT,
  "sentAt"            TIMESTAMP(3),
  "deliveredAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "EmailEvent_outboxId_key"              ON "EmailEvent"("outboxId");
CREATE UNIQUE INDEX IF NOT EXISTS "EmailEvent_userId_kind_scopeKey_key"  ON "EmailEvent"("userId","kind","scopeKey");
CREATE INDEX        IF NOT EXISTS "EmailEvent_providerMessageId_idx"     ON "EmailEvent"("providerMessageId");
CREATE INDEX        IF NOT EXISTS "EmailEvent_status_createdAt_idx"      ON "EmailEvent"("status","createdAt");

DO $$ BEGIN
  ALTER TABLE "EmailEvent"
    ADD CONSTRAINT "EmailEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── EmailSuppression: global do-not-send list ─────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailSuppression" (
  "email"   TEXT         NOT NULL,
  "reason"  TEXT         NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"   TEXT,
  "userId"  TEXT,
  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email")
);
CREATE INDEX IF NOT EXISTS "EmailSuppression_reason_addedAt_idx" ON "EmailSuppression"("reason","addedAt");

-- ─── ScheduledEmail: delayed-send queue ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ScheduledEmail" (
  "id"         TEXT         NOT NULL,
  "runAt"      TIMESTAMP(3) NOT NULL,
  "kind"       TEXT         NOT NULL,
  "userId"     TEXT,
  "toEmail"    TEXT         NOT NULL,
  "scopeKey"   TEXT         NOT NULL DEFAULT '',
  "payload"    JSONB        NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledEmail_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScheduledEmail_runAt_releasedAt_idx" ON "ScheduledEmail"("runAt","releasedAt");
CREATE INDEX IF NOT EXISTS "ScheduledEmail_userId_kind_idx"      ON "ScheduledEmail"("userId","kind");

-- ─── MagicLinkToken: single-use email-embedded link tokens ─────────────────
CREATE TABLE IF NOT EXISTS "MagicLinkToken" (
  "token"     TEXT         NOT NULL,
  "kind"      TEXT         NOT NULL,
  "userId"    TEXT,
  "email"     TEXT         NOT NULL,
  "payload"   JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("token")
);
CREATE INDEX IF NOT EXISTS "MagicLinkToken_email_kind_idx"  ON "MagicLinkToken"("email","kind");
CREATE INDEX IF NOT EXISTS "MagicLinkToken_expiresAt_idx"   ON "MagicLinkToken"("expiresAt");

-- ─── McpRelease: announcement record per minor/major publish ───────────────
CREATE TABLE IF NOT EXISTS "McpRelease" (
  "version"           TEXT         NOT NULL,
  "prevVersion"       TEXT         NOT NULL,
  "kind"              TEXT         NOT NULL,
  "releaseNotesUrl"   TEXT         NOT NULL,
  "deprecations"      JSONB,
  "announcedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fanoutCompletedAt" TIMESTAMP(3),
  CONSTRAINT "McpRelease_pkey" PRIMARY KEY ("version")
);

-- ─── Waitlist: free-month Pro waitlist from daily-limit email CTA ──────────
CREATE TABLE IF NOT EXISTS "Waitlist" (
  "id"                 TEXT         NOT NULL,
  "email"              TEXT         NOT NULL,
  "userId"             TEXT,
  "source"             TEXT         NOT NULL DEFAULT 'daily_limit_email',
  "joinedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "granted"            BOOLEAN      NOT NULL DEFAULT false,
  "grantedAt"          TIMESTAMP(3),
  "freeMonthExpiresAt" TIMESTAMP(3),
  "notes"              TEXT,
  CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Waitlist_email_key"           ON "Waitlist"("email");
CREATE INDEX        IF NOT EXISTS "Waitlist_granted_joinedAt_idx" ON "Waitlist"("granted","joinedAt");
