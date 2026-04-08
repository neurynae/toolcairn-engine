-- CreateTable
CREATE TABLE "StagedNode" (
    "id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "node_data" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "supporting_queries" TEXT[],
    "graduated" BOOLEAN NOT NULL DEFAULT false,
    "graduated_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagedNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedEdge" (
    "id" TEXT NOT NULL,
    "edge_type" TEXT NOT NULL,
    "source_node_id" TEXT NOT NULL,
    "target_node_id" TEXT NOT NULL,
    "edge_data" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "supporting_queries" TEXT[],
    "graduated" BOOLEAN NOT NULL DEFAULT false,
    "graduated_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagedEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchSession" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "context" JSONB,
    "clarification_history" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "results" JSONB,
    "stage" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutcomeReport" (
    "id" TEXT NOT NULL,
    "query_id" TEXT NOT NULL,
    "chosen_tool" TEXT NOT NULL,
    "reason" TEXT,
    "outcome" TEXT,
    "feedback" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexedTool" (
    "id" TEXT NOT NULL,
    "github_url" TEXT NOT NULL,
    "graph_node_id" TEXT,
    "last_indexed_at" TIMESTAMP(3),
    "index_status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexedTool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StagedNode_node_type_graduated_idx" ON "StagedNode"("node_type", "graduated");

-- CreateIndex
CREATE INDEX "StagedNode_confidence_idx" ON "StagedNode"("confidence");

-- CreateIndex
CREATE INDEX "StagedEdge_edge_type_graduated_idx" ON "StagedEdge"("edge_type", "graduated");

-- CreateIndex
CREATE INDEX "StagedEdge_source_node_id_target_node_id_idx" ON "StagedEdge"("source_node_id", "target_node_id");

-- CreateIndex
CREATE INDEX "SearchSession_status_expires_at_idx" ON "SearchSession"("status", "expires_at");

-- CreateIndex
CREATE INDEX "OutcomeReport_processed_idx" ON "OutcomeReport"("processed");

-- CreateIndex
CREATE INDEX "OutcomeReport_chosen_tool_idx" ON "OutcomeReport"("chosen_tool");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedTool_github_url_key" ON "IndexedTool"("github_url");

-- CreateIndex
CREATE INDEX "IndexedTool_index_status_idx" ON "IndexedTool"("index_status");

-- CreateIndex
CREATE INDEX "IndexedTool_last_indexed_at_idx" ON "IndexedTool"("last_indexed_at");

-- AddForeignKey
ALTER TABLE "OutcomeReport" ADD CONSTRAINT "OutcomeReport_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "SearchSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
