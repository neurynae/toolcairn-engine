/**
 * Weekly Digest Scheduler — runs every Monday at 06:00 UTC.
 *
 * Finds all Pro users with emailDigestEnabled=true, builds a personalised
 * email with their tool usage, any deprecation alerts, and trending tools,
 * then sends via Resend.
 */

import { prisma } from '@toolcairn/db';
import pino from 'pino';
import { sendEmail } from '../email/resend-client.js';
import { buildWeeklyDigestHtml } from '../email/templates/weekly-digest.js';

const logger = pino({ name: '@toolcairn/indexer:digest-scheduler' });

/** Returns true if right now is Monday 06:00–06:59 UTC */
function isMonday6am(): boolean {
  const now = new Date();
  return now.getUTCDay() === 1 && now.getUTCHours() === 6;
}

function weekStartLabel(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Generate a simple token for unsubscribe links (not cryptographically signed — just enough for UX) */
function makeUnsubToken(userId: string): string {
  return Buffer.from(`${userId}:digest`).toString('base64url');
}

export async function runDigestScheduler(): Promise<void> {
  if (!isMonday6am()) return; // only run once per week

  logger.info('Weekly digest scheduler starting');
  const weekStart = weekStartLabel();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    // Find Pro users with digest enabled
    const users = await prisma.user.findMany({
      where: {
        emailDigestEnabled: true,
        plan: 'pro',
        planExpiresAt: { gt: new Date() },
        email: { not: '' },
      },
      select: { id: true, name: true, email: true },
    });

    if (users.length === 0) {
      logger.info('No eligible digest recipients');
      return;
    }

    // Fetch trending tools once (shared across all emails)
    const trendingRows = await prisma.usageAggregate.groupBy({
      by: ['tool_name'],
      where: { period: 'daily', period_start: { gte: weekAgo } },
      _sum: { call_count: true },
      orderBy: { _sum: { call_count: 'desc' } },
      take: 5,
    });
    const trendingTools = trendingRows.map((r) => ({
      tool_name: r.tool_name,
      quality_score: null,
    }));

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        // Tools this user used in the last 7 days (from Redis sorted set)
        const toolsUsed: Array<{ tool_name: string; count: number }> = [];
        try {
          const { Redis } = await import('ioredis');
          const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
            lazyConnect: true,
            connectTimeout: 2000,
            maxRetriesPerRequest: 0,
          });
          await redis.connect();
          try {
            const raw = await redis.zrevrangebyscore(
              `user:${user.id}:tool_prefs`,
              '+inf',
              '-inf',
              'WITHSCORES',
              'LIMIT',
              0,
              5,
            );
            for (let i = 0; i < raw.length - 1; i += 2) {
              toolsUsed.push({ tool_name: raw[i] as string, count: Number(raw[i + 1]) });
            }
          } finally {
            redis.disconnect();
          }
        } catch {
          // Redis unavailable — skip tools used section
        }

        // Deprecation alerts for tools this user watches
        const subscriptions = await prisma.alertSubscription.findMany({
          where: { user_id: user.id },
          select: { tool_name: true },
        });
        const watchedTools = subscriptions.map((s) => s.tool_name);

        const deprecationAlerts =
          watchedTools.length > 0
            ? await prisma.deprecationAlert.findMany({
                where: {
                  tool_name: { in: watchedTools },
                  created_at: { gte: weekAgo },
                },
                select: { tool_name: true, severity: true, details: true },
                take: 5,
              })
            : [];

        const html = buildWeeklyDigestHtml({
          userName: user.name ?? '',
          userEmail: user.email ?? '',
          weekStart,
          toolsUsed,
          deprecationAlerts,
          trendingTools,
          unsubscribeToken: makeUnsubToken(user.id),
        });

        if (!html) {
          logger.debug({ userId: user.id }, 'Empty digest — skipping');
          continue;
        }

        const ok = await sendEmail({
          to: user.email ?? '',
          subject: `Your ToolCairn Weekly Digest — ${weekStart}`,
          html,
        });

        if (ok) sent++;
        else failed++;
      } catch (e) {
        logger.error({ userId: user.id, err: e }, 'Digest failed for user');
        failed++;
      }
    }

    logger.info({ sent, failed, total: users.length }, 'Weekly digest complete');
  } catch (e) {
    logger.error({ err: e }, 'Digest scheduler error');
  }
}
