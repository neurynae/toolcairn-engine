import { config } from '@toolcairn/config';
import { createLogger } from '@toolcairn/errors';
import { Redis } from 'ioredis';
import type { QueueMessage } from './types.js';

const logger = createLogger({ name: '@toolcairn/queue:consumer' });

const INDEX_STREAM = 'toolpilot:index';
const SEARCH_STREAM = 'toolpilot:search';
const SCHEDULER_STREAM = 'toolpilot:scheduler';

export interface QueueHandlers {
  onIndexJob: (toolId: string, priority: number) => Promise<void>;
  onSearchEvent: (query: string, sessionId: string) => Promise<void>;
  onRunDiscovery?: () => Promise<void>;
  /** force=true when triggeredBy==='manual' — bypasses 7-day staleness threshold */
  onRunReindex?: (force?: boolean) => Promise<void>;
}

let redisClient: Redis | undefined;

function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.REDIS_URL);
  }
  return redisClient;
}

async function ensureConsumerGroup(stream: string, group: string): Promise<void> {
  const redis = getRedisClient();
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
  } catch (e) {
    // BUSYGROUP = group already exists — expected on warm restart, ignore
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('BUSYGROUP')) {
      // Any other error (connection failure, etc.) — re-throw so the caller fails
      // clearly instead of silently leaving the group uncreated and crashing on XREADGROUP
      throw e;
    }
  }
}

type StreamMessage = QueueMessage & { _streamKey: string; _entryId: string };

/**
 * Read messages from both streams using consumer groups.
 * Returned messages carry _streamKey and _entryId for correct acknowledgement.
 */
export async function readFromStream(
  group: string,
  consumer: string,
  count: number,
): Promise<StreamMessage[]> {
  const redis = getRedisClient();

  await ensureConsumerGroup(INDEX_STREAM, group);
  await ensureConsumerGroup(SEARCH_STREAM, group);
  await ensureConsumerGroup(SCHEDULER_STREAM, group);

  const [indexResult, searchResult, schedulerResult] = await Promise.all([
    redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      String(count),
      'STREAMS',
      INDEX_STREAM,
      '>',
    ),
    redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      String(count),
      'STREAMS',
      SEARCH_STREAM,
      '>',
    ),
    redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      String(count),
      'STREAMS',
      SCHEDULER_STREAM,
      '>',
    ),
  ]);

  const messages: StreamMessage[] = [];

  const streams: Array<[typeof indexResult, string]> = [
    [indexResult, INDEX_STREAM],
    [searchResult, SEARCH_STREAM],
    [schedulerResult, SCHEDULER_STREAM],
  ];

  for (const [streamResult, streamKey] of streams) {
    if (!streamResult) continue;
    for (const [, entries] of streamResult as [string, [string, string[]][]][]) {
      for (const [entryId, fields] of entries) {
        const map: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          map[fields[i] ?? ''] = fields[i + 1] ?? '';
        }
        const appId = map.id;
        const type = map.type;
        const payload = map.payload;
        const timestamp = map.timestamp;
        if (!appId || !type || !payload || !timestamp) continue;
        messages.push({
          id: appId,
          type,
          payload: JSON.parse(payload),
          timestamp: Number(timestamp),
          _streamKey: streamKey,
          _entryId: entryId,
        });
      }
    }
  }

  return messages;
}

/**
 * Read messages from a specific start position (for draining the PEL).
 * Unlike readFromStream (which uses '>'), this reads already-delivered
 * messages owned by this consumer — used to process reclaimed PEL entries.
 */
async function readFromPEL(
  group: string,
  consumer: string,
  count: number,
): Promise<StreamMessage[]> {
  const redis = getRedisClient();
  const messages: StreamMessage[] = [];

  for (const stream of [INDEX_STREAM, SCHEDULER_STREAM]) {
    try {
      // '0' reads messages already in this consumer's PEL (not new ones)
      const result = await redis.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        String(count),
        'STREAMS',
        stream,
        '0',
      );
      if (!result) continue;
      for (const [, entries] of result as [string, [string, string[]][]][]) {
        for (const [entryId, fields] of entries) {
          const map: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            map[fields[i] ?? ''] = fields[i + 1] ?? '';
          }
          const appId = map.id;
          const type = map.type;
          const payload = map.payload;
          const timestamp = map.timestamp;

          if (!appId || !type || !payload || !timestamp) {
            // Old single-field format: entire message serialised into 'data' key.
            // Try to parse it so we can still process valid messages.
            if (map.data) {
              try {
                const parsed = JSON.parse(map.data) as Record<string, unknown>;
                if (parsed.id && parsed.type && parsed.payload && parsed.timestamp) {
                  messages.push({
                    id: String(parsed.id),
                    type: String(parsed.type),
                    payload: parsed.payload,
                    timestamp: Number(parsed.timestamp),
                    _streamKey: stream,
                    _entryId: entryId,
                  });
                  continue;
                }
              } catch {
                // fall through to stale placeholder
              }
            }
            // Unrecognised format — push a placeholder so the drain loop
            // still XACKs this entry and clears it from the PEL.
            messages.push({
              id: entryId,
              type: '_stale',
              payload: {},
              timestamp: 0,
              _streamKey: stream,
              _entryId: entryId,
            });
            continue;
          }

          messages.push({
            id: appId,
            type,
            payload: JSON.parse(payload),
            timestamp: Number(timestamp),
            _streamKey: stream,
            _entryId: entryId,
          });
        }
      }
    } catch (e) {
      logger.warn({ err: e, stream }, 'readFromPEL failed — skipping');
    }
  }
  return messages;
}

/**
 * Claim and process messages stuck in the PEL (delivered to dead consumers,
 * never acknowledged). Runs once at startup using XAUTOCLAIM (Redis 7+).
 *
 * Key fix: XAUTOCLAIM transfers ownership but does NOT re-deliver messages
 * via '>'. We must explicitly drain the PEL with '0' reads after claiming.
 */
async function reclaimStalePending(group: string, consumer: string): Promise<number> {
  const redis = getRedisClient();
  const IDLE_MS = 60_000; // reclaim messages idle > 1 minute
  const BATCH = 500;
  let totalClaimed = 0;

  for (const stream of [INDEX_STREAM, SCHEDULER_STREAM]) {
    try {
      // Loop with cursor until XAUTOCLAIM returns '0-0' (all PEL entries scanned).
      // A single call with COUNT 500 only claims the first 500 messages — without
      // the loop, thousands of orphaned messages from dead containers are never reclaimed.
      let cursor = '0-0';
      while (true) {
        const result = await redis.xautoclaim(
          stream,
          group,
          consumer,
          IDLE_MS,
          cursor,
          'COUNT',
          String(BATCH),
        );
        // ioredis returns [nextCursor, [[entryId, fields], ...], deletedIds]
        const nextCursor = result[0] as string;
        const entries: [string, string[]][] = Array.isArray(result[1]) ? result[1] : [];
        if (entries.length > 0) {
          totalClaimed += entries.length;
          logger.info({ stream, count: entries.length, nextCursor }, 'Reclaimed stale PEL batch');
        }
        // '0-0' cursor means all PEL entries have been scanned
        if (nextCursor === '0-0' || entries.length === 0) break;
        cursor = nextCursor;
      }
      if (totalClaimed > 0) {
        logger.info({ stream, totalClaimed }, 'PEL reclaim complete — will drain');
      }
    } catch (e) {
      logger.warn({ err: e, stream }, 'XAUTOCLAIM failed — skipping PEL recovery');
    }
  }

  return totalClaimed;
}

export interface ConsumerOptions {
  /**
   * Number of index-job messages to process concurrently within a single batch.
   * Default: 2. Higher values increase throughput but also Postgres connections
   * (N containers × concurrency = N×concurrency simultaneous Prisma connections).
   * With 2 containers × concurrency=2 = 4 parallel jobs — safe for VPS Postgres.
   */
  concurrency?: number;
  /**
   * If set, the consumer exits after the queue has been continuously empty for
   * this many milliseconds. Useful for one-shot CI runs.
   * Default: undefined (run forever until SIGTERM/SIGINT).
   */
  idleExitMs?: number;
}

/**
 * Start the consumer loop — reads messages and dispatches to handlers.
 * Backs off on empty polls (100ms → 1s). Exits cleanly on SIGTERM/SIGINT.
 * Pass `idleExitMs` to auto-exit after the queue has been empty for that duration
 * (useful for CI one-shot runs so the job terminates when all work is done).
 */
export async function startConsumer(
  handlers: QueueHandlers,
  options: ConsumerOptions = {},
): Promise<void> {
  const group = 'toolpilot-consumers';
  // Use hostname (Docker sets a unique hostname per container) + pid for uniqueness.
  // Previously used process.pid alone which is always 1 in Docker — causing all
  // containers to share consumer-1 and potentially reclaim each other's pending messages.
  // process.env.HOSTNAME is set by Docker to the container ID — unique per container.
  // Fallback to process.pid (works in non-Docker envs, but collides in Docker since pid=1).
  const consumer = `consumer-${process.env.HOSTNAME || process.pid}-${process.pid}`;
  let running = true;
  let emptyPollCount = 0;
  let idleStartMs: number | null = null;

  const shutdown = () => {
    running = false;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    // On startup: reclaim PEL messages from dead consumers, then drain them.
    // reclaimStalePending uses XAUTOCLAIM which transfers ownership but does NOT
    // re-deliver via '>'. We must explicitly process the PEL with '0' reads.
    const claimedCount = await reclaimStalePending(group, consumer);
    if (claimedCount > 0) {
      logger.info({ claimedCount }, 'Draining PEL — processing reclaimed messages');
      let pelMessages = await readFromPEL(group, consumer, 10);
      while (pelMessages.length > 0) {
        for (const msg of pelMessages) {
          try {
            if (msg.type === 'index-job') {
              const { toolId, priority } = msg.payload as { toolId: string; priority: number };
              await handlers.onIndexJob(toolId, priority);
            } else if (msg.type === 'run-discovery' && handlers.onRunDiscovery) {
              await handlers.onRunDiscovery();
            } else if (msg.type === 'run-reindex' && handlers.onRunReindex) {
              const { triggeredBy } = (msg.payload ?? {}) as { triggeredBy?: string };
              await handlers.onRunReindex(triggeredBy === 'manual');
            }
          } catch (e) {
            logger.error({ err: e, messageId: msg.id }, 'PEL drain: message processing failed');
          }
        }
        const redis = getRedisClient();
        const indexIds = pelMessages
          .filter((m) => m._streamKey === INDEX_STREAM)
          .map((m) => m._entryId);
        const schedulerIds = pelMessages
          .filter((m) => m._streamKey === SCHEDULER_STREAM)
          .map((m) => m._entryId);
        if (indexIds.length > 0) await redis.xack(INDEX_STREAM, group, ...indexIds);
        if (schedulerIds.length > 0) await redis.xack(SCHEDULER_STREAM, group, ...schedulerIds);
        pelMessages = await readFromPEL(group, consumer, 10);
      }
      logger.info('PEL drain complete');
    }

    while (running) {
      const messages = await readFromStream(group, consumer, 10);

      if (messages.length === 0) {
        // Exponential backoff: 100ms base, +50ms per consecutive empty poll, max 1s
        const delay = Math.min(100 + emptyPollCount * 50, 1000);
        emptyPollCount++;

        // Idle-exit: if queue has been empty for idleExitMs, stop the consumer
        if (options.idleExitMs !== undefined) {
          if (idleStartMs === null) idleStartMs = Date.now();
          const idleDuration = Date.now() - idleStartMs;
          if (idleDuration >= options.idleExitMs) {
            logger.info(
              { idleDurationMs: idleDuration, idleExitMs: options.idleExitMs },
              'Queue idle — consumer exiting (idle-exit mode)',
            );
            running = false;
            break;
          }
        }

        await new Promise<void>((r) => setTimeout(r, delay));
        continue;
      }

      // Messages received — reset idle tracking
      idleStartMs = null;
      emptyPollCount = 0;

      // Pipeline parallelism: process index-job messages concurrently up to
      // `concurrency` at a time. Other message types run sequentially (they
      // are rare scheduler events that must not overlap — discovery, reindex).
      const concurrency = options.concurrency ?? 2;
      const indexMessages = messages.filter((m) => m.type === 'index-job');
      const otherMessages = messages.filter((m) => m.type !== 'index-job');

      // 2-minute ceiling per job — prevents a hung download fetch or stalled
      // GitHub API call from blocking the whole batch indefinitely.
      const JOB_TIMEOUT_MS = 120_000;

      // Process index jobs in concurrent sliding windows.
      // Each message is XACK'd immediately after its own job completes (success,
      // failure, or timeout) rather than waiting for the whole batch. This means
      // a slow job never holds other messages in the PEL.
      for (let i = 0; i < indexMessages.length; i += concurrency) {
        const batch = indexMessages.slice(i, i + concurrency);
        await Promise.allSettled(
          batch.map(async (msg) => {
            const { toolId, priority } = msg.payload as { toolId: string; priority: number };
            try {
              await Promise.race([
                handlers.onIndexJob(toolId, priority),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error(`Job timeout after ${JOB_TIMEOUT_MS}ms`)),
                    JOB_TIMEOUT_MS,
                  ),
                ),
              ]);
            } catch (e) {
              logger.error(
                { err: e, messageId: msg.id, toolId },
                'Index job failed (non-fatal)',
              );
            }
            // XACK immediately — regardless of success / failure / timeout.
            // Per-message so one slow job can't strand the other 9 in the PEL.
            try {
              const r = getRedisClient();
              await r.xack(msg._streamKey, group, msg._entryId);
            } catch (e) {
              logger.warn({ err: e, entryId: msg._entryId }, 'XACK failed');
            }
          }),
        );
      }

      // Process non-index messages sequentially
      for (const msg of otherMessages) {
        try {
          if (msg.type === 'search-event') {
            const { query, sessionId } = msg.payload as { query: string; sessionId: string };
            await handlers.onSearchEvent(query, sessionId);
          } else if (msg.type === 'run-discovery' && handlers.onRunDiscovery) {
            await handlers.onRunDiscovery();
          } else if (msg.type === 'run-reindex' && handlers.onRunReindex) {
            const { triggeredBy } = (msg.payload ?? {}) as { triggeredBy?: string };
            await handlers.onRunReindex(triggeredBy === 'manual');
          }
        } catch (e) {
          logger.error(
            { err: e, messageId: msg.id, messageType: msg.type },
            'Message processing failed',
          );
        }
      }

      // XACK non-index messages (search, scheduler) — these are fast and don't hang.
      // Index messages are already XACK'd per-message above.
      const redis = getRedisClient();
      const searchIds = messages
        .filter((m) => m._streamKey === SEARCH_STREAM)
        .map((m) => m._entryId);
      const schedulerIds = messages
        .filter((m) => m._streamKey === SCHEDULER_STREAM)
        .map((m) => m._entryId);

      if (searchIds.length > 0) await redis.xack(SEARCH_STREAM, group, ...searchIds);
      if (schedulerIds.length > 0) await redis.xack(SCHEDULER_STREAM, group, ...schedulerIds);
    }
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    logger.info('Consumer loop stopped');
  }
}
