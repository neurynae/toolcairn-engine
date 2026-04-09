-- AlterTable
ALTER TABLE "McpEvent" ADD COLUMN     "user_id" TEXT;

-- AlterTable
ALTER TABLE "SearchSession" ADD COLUMN     "co_occurrence_processed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StagedNode" ADD COLUMN     "submitted_by" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "alertWebhookUrl" TEXT,
ADD COLUMN     "emailDigestEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "razorpayCustomerId" TEXT,
ADD COLUMN     "razorpaySubscriptionId" TEXT;

-- CreateTable
CREATE TABLE "UsageAggregate" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "tool_name" TEXT NOT NULL,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "avg_duration_ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unique_users" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLoadSnapshot" (
    "id" TEXT NOT NULL,
    "queue_depth" INTEGER NOT NULL,
    "api_latency_p95_ms" INTEGER NOT NULL,
    "active_connections" INTEGER NOT NULL DEFAULT 0,
    "free_tier_limit" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLoadSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeprecationAlert" (
    "id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeprecationAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSubscription" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageAggregate_period_period_start_idx" ON "UsageAggregate"("period", "period_start");

-- CreateIndex
CREATE INDEX "UsageAggregate_tool_name_period_idx" ON "UsageAggregate"("tool_name", "period");

-- CreateIndex
CREATE UNIQUE INDEX "UsageAggregate_period_period_start_tool_name_key" ON "UsageAggregate"("period", "period_start", "tool_name");

-- CreateIndex
CREATE INDEX "SystemLoadSnapshot_created_at_idx" ON "SystemLoadSnapshot"("created_at");

-- CreateIndex
CREATE INDEX "DeprecationAlert_tool_name_created_at_idx" ON "DeprecationAlert"("tool_name", "created_at");

-- CreateIndex
CREATE INDEX "DeprecationAlert_delivered_idx" ON "DeprecationAlert"("delivered");

-- CreateIndex
CREATE INDEX "AlertSubscription_tool_name_idx" ON "AlertSubscription"("tool_name");

-- CreateIndex
CREATE UNIQUE INDEX "AlertSubscription_user_id_tool_name_key" ON "AlertSubscription"("user_id", "tool_name");

-- CreateIndex
CREATE INDEX "McpEvent_user_id_created_at_idx" ON "McpEvent"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "SearchSession_co_occurrence_processed_status_idx" ON "SearchSession"("co_occurrence_processed", "status");

-- CreateIndex
CREATE INDEX "StagedNode_submitted_by_idx" ON "StagedNode"("submitted_by");

-- CreateIndex
CREATE UNIQUE INDEX "User_razorpayCustomerId_key" ON "User"("razorpayCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_razorpaySubscriptionId_key" ON "User"("razorpaySubscriptionId");

-- AddForeignKey
ALTER TABLE "AlertSubscription" ADD CONSTRAINT "AlertSubscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
