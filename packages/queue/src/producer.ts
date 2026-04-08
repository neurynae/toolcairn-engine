import { config } from '@toolcairn/config';
import { type Result, err, ok } from '@toolcairn/core';
import { Redis } from 'ioredis';
import type { QueueError, QueueMessage } from './types.js';

export type { QueueError, QueueMessage };

const INDEX_STREAM = 'toolpilot:index';
const SEARCH_STREAM = 'toolpilot:search';

let redisClient: Redis | undefined;

function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.REDIS_URL);
  }
  return redisClient;
}

/**
 * Enqueue a GitHub indexing job for a tool.
 */
export async function enqueueIndexJob(
  toolId: string,
  priority: number,
): Promise<Result<string, QueueError>> {
  try {
    const redis = getRedisClient();
    const message: QueueMessage = {
      id: crypto.randomUUID(),
      type: 'index-job',
      payload: { toolId, priority },
      timestamp: Date.now(),
    };

    const streamId = await redis.xadd(
      INDEX_STREAM,
      '*',
      'id',
      message.id,
      'type',
      message.type,
      'payload',
      JSON.stringify(message.payload),
      'timestamp',
      String(message.timestamp),
    );

    return ok(streamId as string);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Enqueue a batch of re-index jobs at low priority (0).
 * Used by the scheduled re-indexer to refresh stale tool health signals.
 */
export async function enqueueBatchReindex(toolIds: string[]): Promise<Result<number, QueueError>> {
  let enqueued = 0;
  for (const toolId of toolIds) {
    const result = await enqueueIndexJob(toolId, 0);
    if (result.ok) enqueued++;
  }
  return ok(enqueued);
}

/**
 * Enqueue a search analytics event.
 */
export async function enqueueSearchEvent(
  query: string,
  sessionId: string,
): Promise<Result<string, QueueError>> {
  try {
    const redis = getRedisClient();
    const message: QueueMessage = {
      id: crypto.randomUUID(),
      type: 'search-event',
      payload: { query, sessionId },
      timestamp: Date.now(),
    };

    const streamId = await redis.xadd(
      SEARCH_STREAM,
      '*',
      'id',
      message.id,
      'type',
      message.type,
      'payload',
      JSON.stringify(message.payload),
      'timestamp',
      String(message.timestamp),
    );

    return ok(streamId as string);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── Scheduler Triggers ───────────────────────────────────────────────────────

const SCHEDULER_STREAM = 'toolpilot:scheduler';

/**
 * Enqueue a trigger to run the discovery scheduler.
 */
export async function enqueueDiscoveryTrigger(): Promise<Result<string, QueueError>> {
  try {
    const redis = getRedisClient();
    const message: QueueMessage = {
      id: crypto.randomUUID(),
      type: 'run-discovery',
      payload: {},
      timestamp: Date.now(),
    };

    const streamId = await redis.xadd(
      SCHEDULER_STREAM,
      '*',
      'id',
      message.id,
      'type',
      message.type,
      'payload',
      JSON.stringify(message.payload),
      'timestamp',
      String(message.timestamp),
    );

    return ok(streamId as string);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Enqueue a trigger to run the reindex scheduler.
 */
export async function enqueueReindexTrigger(): Promise<Result<string, QueueError>> {
  try {
    const redis = getRedisClient();
    const message: QueueMessage = {
      id: crypto.randomUUID(),
      type: 'run-reindex',
      payload: {},
      timestamp: Date.now(),
    };

    const streamId = await redis.xadd(
      SCHEDULER_STREAM,
      '*',
      'id',
      message.id,
      'type',
      message.type,
      'payload',
      JSON.stringify(message.payload),
      'timestamp',
      String(message.timestamp),
    );

    return ok(streamId as string);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
