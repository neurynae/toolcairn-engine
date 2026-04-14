-- AddColumn IndexedTool: stars, weekly_downloads, skip_reason (quality gate tracking)
-- AddColumn AppSettings: download_quality_thresholds (percentile-based gate thresholds)

ALTER TABLE "IndexedTool"
  ADD COLUMN IF NOT EXISTS "stars"             INTEGER,
  ADD COLUMN IF NOT EXISTS "weekly_downloads"  INTEGER,
  ADD COLUMN IF NOT EXISTS "skip_reason"       TEXT;

CREATE INDEX IF NOT EXISTS "IndexedTool_stars_idx"            ON "IndexedTool"("stars");
CREATE INDEX IF NOT EXISTS "IndexedTool_weekly_downloads_idx" ON "IndexedTool"("weekly_downloads");

ALTER TABLE "AppSettings"
  ADD COLUMN IF NOT EXISTS "download_quality_thresholds" TEXT;
