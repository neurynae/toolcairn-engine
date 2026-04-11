/**
 * Log cleanup script — deletes error log files older than 30 days.
 *
 * Run at container startup before the main process, or as a daily cron.
 * Usage: tsx scripts/cleanup-logs.ts
 *
 * Respects LOG_DIR env var (default: /app/logs).
 * Only deletes files matching the pattern error-YYYY-MM-DD.log and mcp-error-YYYY-MM-DD.log.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = process.env.LOG_DIR ?? '/app/logs';
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? '30');
const LOG_FILE_PATTERN = /^(mcp-)?error-\d{4}-\d{2}-\d{2}\.log$/;

async function cleanupLogs(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  let files: string[];
  try {
    files = await readdir(LOG_DIR);
  } catch {
    // Log directory doesn't exist yet — nothing to clean
    return;
  }

  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    if (!LOG_FILE_PATTERN.test(file)) continue;

    const filePath = join(LOG_DIR, file);
    try {
      const { mtime } = await stat(filePath);
      if (mtime < cutoff) {
        await unlink(filePath);
        deleted++;
        console.log(`[cleanup-logs] Deleted: ${filePath} (mtime: ${mtime.toISOString()})`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(`[cleanup-logs] Failed to process ${filePath}:`, err);
    }
  }

  console.log(
    `[cleanup-logs] Done: ${deleted} deleted, ${skipped} kept, ${errors} errors. Cutoff: ${cutoff.toISOString()}`,
  );
}

cleanupLogs().catch((err) => {
  console.error('[cleanup-logs] Unexpected error:', err);
  process.exit(1);
});
