import { config } from '@toolcairn/config';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { QueueMessage } from './types.js';

const logger = pino({ name: '@toolcairn/queue:consumer' });

const INDEX_STREAM = 'toolpilot:index';
const SEARCH_STREAM = 'toolpilot:search';
const SCHEDULER_STREAM = 'toolpilot:scheduler';

export interface QueueHandlers {
  onIndexJob: (toolId: string, priority: number) => Promise<void>;
  onSearchEvent: (query: string, sessionId: string) => Promise<void>;
  onRunDiscovery?: () => Promise<void>;
  onRunReindex?: () => Promise<void>;
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
          if (!appId || !type || !payload || !timestamp) continue;
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
  let totalClaimed = 0;

  for (const stream of [INDEX_STREAM, SCHEDULER_STREAM]) {
    try {
      // Transfer orphaned PEL entries to this consumer
      const result = await redis.xautoclaim(
        stream,
        group,
        consumer,
        IDLE_MS,
        '0-0',
        'COUNT',
        '500',
      );
      // ioredis returns [nextId, [[entryId, fields], ...], deletedIds]
      const entries: [string, string[]][] = Array.isArray(result[1]) ? result[1] : [];
      if (entries.length > 0) {
        totalClaimed += entries.length;
        logger.info({ stream, count: entries.length }, 'Reclaimed stale PEL messages — will drain');
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
   * Higher values use more GitHub API quota but reduce wall-clock time per batch.
   * Default: 3. With 2 tokens (10k req/hr) and ~5 calls/tool, max effective = 5.
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
  const consumer = `consumer-${process.pid}`;
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
              await handlers.onRunReindex();
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
      const concurrency = options.concurrency ?? 3;
      const indexMessages = messages.filter((m) => m.type === 'index-job');
      const otherMessages = messages.filter((m) => m.type !== 'index-job');

      // Process index jobs in concurrent sliding windows
      for (let i = 0; i < indexMessages.length; i += concurrency) {
        const batch = indexMessages.slice(i, i + concurrency);
        await Promise.allSettled(
          batch.map(async (msg) => {
            const { toolId, priority } = msg.payload as { toolId: string; priority: number };
            try {
              await handlers.onIndexJob(toolId, priority);
            } catch (e) {
              logger.error(
                { err: e, messageId: msg.id, toolId },
                'Index job failed (non-fatal — will be reclaimed)',
              );
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
            await handlers.onRunReindex();
          }
        } catch (e) {
          logger.error(
            { err: e, messageId: msg.id, messageType: msg.type },
            'Message processing failed',
          );
        }
      }

      // Acknowledge each message only against its originating stream
      const redis = getRedisClient();
      const indexIds = messages.filter((m) => m._streamKey === INDEX_STREAM).map((m) => m._entryId);
      const searchIds = messages
        .filter((m) => m._streamKey === SEARCH_STREAM)
        .map((m) => m._entryId);
      const schedulerIds = messages
        .filter((m) => m._streamKey === SCHEDULER_STREAM)
        .map((m) => m._entryId);

      if (indexIds.length > 0) await redis.xack(INDEX_STREAM, group, ...indexIds);
      if (searchIds.length > 0) await redis.xack(SEARCH_STREAM, group, ...searchIds);
      if (schedulerIds.length > 0) await redis.xack(SCHEDULER_STREAM, group, ...schedulerIds);
    }
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    logger.info('Consumer loop stopped');
  }
}
