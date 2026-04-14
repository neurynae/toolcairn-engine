/**
 * Cron job status, logs, and manual trigger endpoints — /v1/admin/cron/*
 *
 * Status is tracked via JSON files in /app/cron-status/ (bind-mounted from
 * /opt/toolcairn/cron-status/ on the VPS host). Wrapper scripts write the
 * JSON before/after each run. Each script also writes a per-job .log file
 * (truncated at run start) for real-time log streaming. Triggers write a
 * .trigger file that the per-minute cron-trigger-watcher.sh picks up.
 *
 * Routes:
 *   GET  /v1/admin/cron              — status of all 3 jobs
 *   GET  /v1/admin/cron/:job/logs    — last N lines of the per-job log file
 *   POST /v1/admin/cron/:job/trigger — write trigger file for manual run
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@toolcairn/errors';
import { enqueueDiscoveryTrigger, enqueueReindexTrigger } from '@toolcairn/queue';
import { Hono } from 'hono';
import { z } from 'zod';

const logger = createLogger({ name: '@toolcairn/api:admin-cron' });

// ─── Constants ────────────────────────────────────────────────────────────────

const CRON_STATUS_DIR = process.env.CRON_STATUS_DIR ?? '/app/cron-status';

/** Cron schedule definitions — UTC */
const JOBS = [
  {
    id: 'daily-indexer',
    label: 'Daily Indexer',
    description: 'Reindexes stale tools and runs burst consumer',
    /** 03:00 UTC daily — 0 3 * * * */
    schedule: { type: 'daily' as const, hour: 3, minute: 0 },
  },
  {
    id: 'search-weights',
    label: 'Search Weights',
    description: 'Updates BM25 weights from outcome reports',
    /** 06:00 UTC daily — 0 6 * * * */
    schedule: { type: 'daily' as const, hour: 6, minute: 0 },
  },
  {
    id: 'weekly-graph',
    label: 'Weekly Graph Refresh',
    description:
      'Centrality, PageRank, canonical flags, personal repo cleanup, download percentiles',
    /** 05:00 UTC every Sunday — 0 5 * * 0 */
    schedule: { type: 'weekly' as const, dayOfWeek: 0, hour: 5, minute: 0 },
  },
] as const;

const JOB_IDS = JOBS.map((j) => j.id);
type JobId = (typeof JOB_IDS)[number];

// ─── Schedule math ────────────────────────────────────────────────────────────

function nextDailyRun(hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function nextWeeklyRun(dayOfWeek: number, hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  const daysUntil = (dayOfWeek - next.getUTCDay() + 7) % 7;
  if (daysUntil === 0 && next <= now) {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    next.setUTCDate(next.getUTCDate() + daysUntil);
  }
  return next;
}

function getNextRun(job: (typeof JOBS)[number]): Date {
  if (job.schedule.type === 'daily') {
    return nextDailyRun(job.schedule.hour, job.schedule.minute);
  }
  return nextWeeklyRun(job.schedule.dayOfWeek, job.schedule.hour, job.schedule.minute);
}

function getLastScheduledRun(job: (typeof JOBS)[number]): Date {
  const next = getNextRun(job);
  const last = new Date(next);
  if (job.schedule.type === 'daily') {
    last.setUTCDate(last.getUTCDate() - 1);
  } else {
    last.setUTCDate(last.getUTCDate() - 7);
  }
  return last;
}

// ─── Status file reading ──────────────────────────────────────────────────────

const StatusFileSchema = z.object({
  status: z.enum(['running', 'success', 'error']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationSec: z.number().nullable(),
  triggeredBy: z.enum(['cron', 'manual']).default('cron'),
  currentStep: z.number().optional(),
  totalSteps: z.number().optional(),
  error: z.string().nullable(),
});

type StatusFile = z.infer<typeof StatusFileSchema>;

async function readStatusFile(jobId: string): Promise<StatusFile | null> {
  const filePath = path.join(CRON_STATUS_DIR, `${jobId}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = StatusFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ─── Trigger file writing ─────────────────────────────────────────────────────

async function writeTriggerFile(jobId: string): Promise<void> {
  const filePath = path.join(CRON_STATUS_DIR, `${jobId}.trigger`);
  await fs.writeFile(filePath, jobId, 'utf8');
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function adminCronRoutes() {
  const app = new Hono();

  // ── GET /v1/admin/cron — status of all jobs ────────────────────────────────
  app.get('/', async (c) => {
    const now = new Date();

    const jobs = await Promise.all(
      JOBS.map(async (job) => {
        const statusFile = await readStatusFile(job.id);
        const nextRunAt = getNextRun(job);
        const lastScheduledAt = getLastScheduledRun(job);
        const timeLeftMs = nextRunAt.getTime() - now.getTime();

        // Determine effective status
        let status: 'running' | 'success' | 'error' | 'waiting' | 'overdue';
        if (statusFile?.status === 'running') {
          status = 'running';
        } else if (statusFile?.status === 'error') {
          status = 'error';
        } else if (statusFile?.status === 'success') {
          // Show as waiting when counting down to next run
          status = 'waiting';
        } else {
          // No status file — check if overdue (should have run > 10min ago with no record)
          const overdueThresholdMs = 10 * 60 * 1000;
          status =
            now.getTime() - lastScheduledAt.getTime() > overdueThresholdMs ? 'overdue' : 'waiting';
        }

        // Pending trigger check
        const triggerPath = path.join(CRON_STATUS_DIR, `${job.id}.trigger`);
        const hasPendingTrigger = await fs
          .access(triggerPath)
          .then(() => true)
          .catch(() => false);

        return {
          id: job.id,
          label: job.label,
          description: job.description,
          status: hasPendingTrigger && status === 'waiting' ? ('pending' as const) : status,
          nextRunAt: nextRunAt.toISOString(),
          lastScheduledAt: lastScheduledAt.toISOString(),
          timeLeftMs,
          lastRun: statusFile
            ? {
                startedAt: statusFile.startedAt,
                finishedAt: statusFile.finishedAt,
                durationSec: statusFile.durationSec,
                triggeredBy: statusFile.triggeredBy,
                currentStep: statusFile.currentStep ?? null,
                totalSteps: statusFile.totalSteps ?? null,
                error: statusFile.error,
              }
            : null,
        };
      }),
    );

    return c.json({ ok: true, data: { jobs } });
  });

  // ── GET /v1/admin/cron/:job/logs — last N lines of the per-job log file ───
  app.get('/:job/logs', async (c) => {
    const jobId = c.req.param('job');
    if (!(JOB_IDS as readonly string[]).includes(jobId)) {
      return c.json({ ok: false, error: `Unknown job: ${jobId}` }, 400);
    }

    const linesParam = Number(c.req.query('lines') ?? '100');
    const lines = Number.isFinite(linesParam) ? Math.min(Math.max(linesParam, 1), 500) : 100;

    const logPath = path.join(CRON_STATUS_DIR, `${jobId}.log`);
    try {
      const raw = await fs.readFile(logPath, 'utf8');
      const allLines = raw.split('\n').filter(Boolean);
      const tail = allLines.slice(-lines);
      return c.json({ ok: true, data: { lines: tail, total: allLines.length } });
    } catch {
      // File doesn't exist yet (job never ran)
      return c.json({ ok: true, data: { lines: [], total: 0 } });
    }
  });

  // ── POST /v1/admin/cron/:job/trigger — manual trigger ─────────────────────
  app.post('/:job/trigger', async (c) => {
    const jobId = c.req.param('job');

    if (!(JOB_IDS as readonly string[]).includes(jobId)) {
      return c.json({ ok: false, error: `Unknown job: ${jobId}` }, 400);
    }

    // Check if already running
    const statusFile = await readStatusFile(jobId);
    if (statusFile?.status === 'running') {
      return c.json({ ok: false, error: 'Job is already running' }, 409);
    }

    try {
      // daily-indexer: enqueue both discovery + reindex to the Redis stream
      // so the running indexer container processes them immediately.
      // Other jobs still use the .trigger file approach for the VPS cron watcher.
      if (jobId === 'daily-indexer') {
        const [discResult, reidxResult] = await Promise.all([
          enqueueDiscoveryTrigger(),
          enqueueReindexTrigger(),
        ]);
        if (!discResult.ok) {
          logger.warn({ error: discResult.error }, 'Failed to enqueue discovery trigger');
        }
        if (!reidxResult.ok) {
          logger.warn({ error: reidxResult.error }, 'Failed to enqueue reindex trigger');
        }
        logger.info({ jobId }, 'Daily indexer triggered via Redis queue');
        return c.json({
          ok: true,
          data: {
            message: 'Daily indexer triggered — discovery + reindex enqueued',
            jobId,
          },
        });
      }

      await writeTriggerFile(jobId as JobId);
      logger.info({ jobId }, 'Cron trigger file written');
      return c.json({
        ok: true,
        data: {
          message: `Trigger queued for ${jobId} — will start within 60s`,
          jobId,
        },
      });
    } catch (e) {
      logger.error({ err: e, jobId }, 'Failed to trigger job');
      return c.json(
        { ok: false, error: e instanceof Error ? e.message : 'Failed to trigger' },
        500,
      );
    }
  });

  return app;
}
