import { config } from '@toolcairn/config';
import { type Result, err, ok } from '@toolcairn/core';
import { Redis } from 'ioredis';
import type { QueueError, QueueMessage } from './types.js';

export type { QueueError, QueueMessage };

const INDEX_STREAM = 'toolpilot:index';
const SEARCH_STREAM = 'toolpilot:search';
const REGISTRY_PROBE_STREAM = 'toolpilot:registry-probe';

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
 * Enqueue a registry-probe job — the indexer's main consumer fires these as a
 * fast handoff after a tool is crawled and written. The probe worker then runs
 * the slow registry verification + download-count fetch at the adaptive
 * per-host rate limiter's pace, in a separate stream so registry slowness
 * (especially pypistats.org) never throttles the main GitHub-bound throughput.
 *
 * Idempotent: re-running for the same toolId just refreshes the channels.
 */
export async function enqueueRegistryProbe(toolId: string): Promise<Result<string, QueueError>> {
  try {
    const redis = getRedisClient();
    const message: QueueMessage = {
      id: crypto.randomUUID(),
      type: 'registry-probe',
      payload: { toolId },
      timestamp: Date.now(),
    };
    const streamId = await redis.xadd(
      REGISTRY_PROBE_STREAM,
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
 * @param triggeredBy - 'cron' (normal staleness check) or 'manual' (force all tools).
 *   Manual triggers bypass the 7-day staleness threshold, matching the TRIGGERED_BY=manual
 *   pattern used in the VPS cron shell scripts.
 */
export async function enqueueReindexTrigger(
  triggeredBy: 'cron' | 'manual' = 'cron',
): Promise<Result<string, QueueError>> {
  try {
    const redis = getRedisClient();
    const message: QueueMessage = {
      id: crypto.randomUUID(),
      type: 'run-reindex',
      payload: { triggeredBy },
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
