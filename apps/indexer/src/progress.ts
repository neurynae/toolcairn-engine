/**
 * Redis-based progress tracker for indexer operations.
 * Writes current state to a Redis key that the admin UI polls.
 * All writes are fire-and-forget (best-effort) — never throws.
 */

import { config } from '@toolcairn/config';
import { Redis } from 'ioredis';

const PROGRESS_KEY = 'toolpilot:indexer:progress';
const TTL_SEC = 3600; // auto-expire after 1 hour

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 0,
      connectTimeout: 2000,
      lazyConnect: false,
    });
    _redis.on('error', () => {
      /* ignore — progress is best-effort */
    });
  }
  return _redis;
}

export interface ProgressState {
  phase: string;
  detail?: string;
  counts?: Record<string, number>;
  ts: string;
}

export async function setProgress(
  phase: string,
  detail?: string,
  counts?: Record<string, number>,
): Promise<void> {
  try {
    const state: ProgressState = { phase, detail, counts, ts: new Date().toISOString() };
    await getRedis().set(PROGRESS_KEY, JSON.stringify(state), 'EX', TTL_SEC);
  } catch {
    /* ignore */
  }
}

export async function clearProgress(): Promise<void> {
  try {
    await getRedis().del(PROGRESS_KEY);
  } catch {
    /* ignore */
  }
}
