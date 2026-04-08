-- CreateTable
CREATE TABLE "McpEvent" (
    "id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "query_id" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpEvent_tool_name_created_at_idx" ON "McpEvent"("tool_name", "created_at");

-- CreateIndex
CREATE INDEX "McpEvent_created_at_idx" ON "McpEvent"("created_at");
