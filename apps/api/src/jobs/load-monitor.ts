/**
 * Load Monitor — runs every 60 seconds.
 *
 * Measures system load (Redis queue depth + API latency p95) and computes
 * the dynamic free-tier daily limit (100–200 calls/day).
 * Writes a SystemLoadSnapshot to Postgres; exposes current state via getCurrentLoad().
 */

import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { Redis } from 'ioredis';

const logger = createLogger({ name: '@toolcairn/api:load-monitor' });
const INTERVAL_MS = 60_000;

/** Rolling window of request latencies for p95 calculation (last 5 minutes). */
const latencyWindow: number[] = [];
const MAX_WINDOW = 300; // 5-min window at 1 sample/sec max

/** Record a request latency sample — called from the request logger middleware. */
export function recordLatency(ms: number): void {
  latencyWindow.push(ms);
  if (latencyWindow.length > MAX_WINDOW) latencyWindow.shift();
}

/** Compute p95 from the current rolling window. Returns 0 if no data. */
export function getLatencyP95(): number {
  if (latencyWindow.length === 0) return 0;
  const sorted = [...latencyWindow].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
}

interface LoadState {
  queue_depth: number;
  api_latency_p95_ms: number;
  free_tier_limit: number;
  computed_at: string;
}

let current: LoadState = {
  queue_depth: 0,
  api_latency_p95_ms: 0,
  free_tier_limit: 15,
  computed_at: new Date().toISOString(),
};

/** Get the latest load snapshot — used by the system route. */
export function getCurrentLoad(): LoadState {
  return current;
}

// Dynamic free-tier daily limit. Range: 10 (high load) → 15 (idle).
// Bonus credits (User.bonusCreditRemaining) kick in once this ceiling is hit.
function computeFreeTierLimit(queueDepth: number, p95Ms: number): number {
  let reduction = 0;
  if (queueDepth > 500) reduction += 3;
  else if (queueDepth > 100) reduction += 2;
  if (p95Ms > 5000) reduction += 2;
  else if (p95Ms > 2000) reduction += 1;
  return Math.max(10, Math.min(15, 15 - reduction));
}

async function measure(): Promise<void> {
  let queueDepth = 0;

  // Measure ACTUAL pending jobs via XINFO GROUPS lag+pending (not XLEN — that's all-time total)
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, connectTimeout: 3000 });
  try {
    await redis.connect();

    async function getPendingCount(stream: string): Promise<number> {
      try {
        // XINFO GROUPS returns group info including lag (undelivered) + pending (in-flight)
        const groups = (await redis.xinfo('GROUPS', stream)) as unknown[][];
        if (!Array.isArray(groups)) return 0;
        return groups.reduce((sum, g) => {
          const arr = g as (string | number)[];
          // Parse key-value pairs: [..., 'lag', N, ..., 'pending', N, ...]
          let lag = 0;
          let pending = 0;
          for (let i = 0; i < arr.length - 1; i += 2) {
            if (arr[i] === 'lag') lag = Number(arr[i + 1]) || 0;
            if (arr[i] === 'pending') pending = Number(arr[i + 1]) || 0;
          }
          return sum + lag + pending;
        }, 0);
      } catch {
        return 0;
      }
    }

    const [indexPending, searchPending] = await Promise.all([
      getPendingCount('toolpilot:index'),
      getPendingCount('toolpilot:search'),
    ]);
    queueDepth = indexPending + searchPending;
  } catch {
    // Non-fatal: use 0
  } finally {
    redis.disconnect();
  }

  const p95 = getLatencyP95();
  const freeLimit = computeFreeTierLimit(queueDepth, p95);

  current = {
    queue_depth: queueDepth,
    api_latency_p95_ms: Math.round(p95),
    free_tier_limit: freeLimit,
    computed_at: new Date().toISOString(),
  };

  // Persist snapshot (non-blocking)
  prisma.systemLoadSnapshot
    .create({
      data: {
        queue_depth: queueDepth,
        api_latency_p95_ms: Math.round(p95),
        free_tier_limit: freeLimit,
      },
    })
    .catch(() => undefined);

  logger.debug({ queueDepth, p95, freeLimit }, 'load snapshot');
}

/** Start the load monitor loop. Call once at server boot. */
export function startLoadMonitor(): void {
  // Run once immediately after a brief startup delay
  setTimeout(measure, 5_000);
  setInterval(measure, INTERVAL_MS);
}
