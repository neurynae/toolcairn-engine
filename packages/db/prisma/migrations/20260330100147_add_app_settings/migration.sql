-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "reindex_scheduler_enabled" BOOLEAN NOT NULL DEFAULT true,
    "discovery_scheduler_enabled" BOOLEAN NOT NULL DEFAULT false,
    "discovery_topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discovery_batch_size" INTEGER NOT NULL DEFAULT 20,
    "discovery_interval_hours" INTEGER NOT NULL DEFAULT 24,
    "discovery_min_stars" INTEGER NOT NULL DEFAULT 100,
    "discovery_last_pushed_days" INTEGER NOT NULL DEFAULT 90,
    "last_discovery_run" TIMESTAMP(3),
    "last_reindex_run" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);
