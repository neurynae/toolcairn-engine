/**
 * Usage Aggregator — runs every hour.
 *
 * Reads McpEvent rows written since the last run, computes per-tool stats,
 * and upserts into UsageAggregate for both hourly and daily periods.
 * This powers the public leaderboard and admin analytics dashboard.
 */

import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/api:usage-aggregator' });
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function floorToHour(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
}

function floorToDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function aggregate(windowStart: Date, windowEnd: Date): Promise<void> {
  // Pull raw events in the window
  const events = await prisma.mcpEvent.findMany({
    where: { created_at: { gte: windowStart, lt: windowEnd } },
    select: { tool_name: true, status: true, duration_ms: true, user_id: true },
  });

  if (events.length === 0) return;

  // Group by tool_name
  const byTool = new Map<
    string,
    { calls: number; errors: number; totalDuration: number; users: Set<string> }
  >();

  for (const ev of events) {
    let entry = byTool.get(ev.tool_name);
    if (!entry) {
      entry = { calls: 0, errors: 0, totalDuration: 0, users: new Set() };
      byTool.set(ev.tool_name, entry);
    }
    entry.calls++;
    if (ev.status === 'error') entry.errors++;
    entry.totalDuration += ev.duration_ms;
    if (ev.user_id) entry.users.add(ev.user_id);
  }

  const hourStart = floorToHour(windowStart);
  const dayStart = floorToDay(windowStart);

  await prisma.$transaction(
    Array.from(byTool.entries()).flatMap(([toolName, stats]) => {
      const avgDuration = stats.calls > 0 ? stats.totalDuration / stats.calls : 0;

      return [
        // Hourly aggregate
        prisma.usageAggregate.upsert({
          where: {
            period_period_start_tool_name: {
              period: 'hourly',
              period_start: hourStart,
              tool_name: toolName,
            },
          },
          create: {
            period: 'hourly',
            period_start: hourStart,
            tool_name: toolName,
            call_count: stats.calls,
            error_count: stats.errors,
            avg_duration_ms: avgDuration,
            unique_users: stats.users.size,
          },
          update: {
            call_count: { increment: stats.calls },
            error_count: { increment: stats.errors },
            avg_duration_ms: avgDuration,
            unique_users: stats.users.size,
          },
        }),
        // Daily aggregate
        prisma.usageAggregate.upsert({
          where: {
            period_period_start_tool_name: {
              period: 'daily',
              period_start: dayStart,
              tool_name: toolName,
            },
          },
          create: {
            period: 'daily',
            period_start: dayStart,
            tool_name: toolName,
            call_count: stats.calls,
            error_count: stats.errors,
            avg_duration_ms: avgDuration,
            unique_users: stats.users.size,
          },
          update: {
            call_count: { increment: stats.calls },
            error_count: { increment: stats.errors },
            avg_duration_ms: avgDuration,
            unique_users: stats.users.size,
          },
        }),
      ];
    }),
  );

  logger.info({ tools: byTool.size, events: events.length, hour: hourStart }, 'usage aggregated');
}

/**
 * Start the hourly aggregation loop.
 * Call once at server boot; runs silently in the background.
 */
export function startUsageAggregator(): void {
  const run = () => {
    const now = new Date();
    const windowEnd = floorToHour(now);
    const windowStart = new Date(windowEnd.getTime() - INTERVAL_MS);

    aggregate(windowStart, windowEnd).catch((err) => {
      logger.error({ err }, 'usage aggregation failed');
    });
  };

  // Run once shortly after startup (offset by 30s to avoid cold-start noise)
  setTimeout(run, 30_000);
  setInterval(run, INTERVAL_MS);
}
