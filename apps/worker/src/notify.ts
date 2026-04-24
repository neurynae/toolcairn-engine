// Fire-and-forget callback to the API on daily-limit threshold crossings.
// Called via ctx.waitUntil from the main request path so user responses are
// never blocked on the notification. Idempotency lives on the API side
// (EmailEvent UNIQUE on userId+kind+date).
import type { Env } from './types.js';

const THRESHOLD_STATE_PREFIX = 'threshold_fired';

type Threshold = 90 | 100;

interface NotifyInput {
  userId: string;
  used: number;
  limit: number;
  threshold: Threshold;
}

/**
 * POST /v1/internal/usage-event on the VPS. The handler there dedupes and
 * enqueues the appropriate email.
 *
 * `kvGuardKey` is a best-effort local dedup: we skip the call if we've
 * already fired the threshold for this (user, date, threshold) today. The
 * ground-truth dedup remains EmailEvent UNIQUE — this just cuts HTTP cost.
 */
export async function notifyUsageEvent(env: Env, input: NotifyInput): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const guardKey = `${THRESHOLD_STATE_PREFIX}:${input.userId}:${date}:${input.threshold}`;

  try {
    const already = await env.KV.get(guardKey);
    if (already) return;
  } catch {
    // KV read failed — proceed anyway; API-side dedup catches it.
  }

  try {
    const url = `${env.API_ORIGIN_URL.replace(/\/$/, '')}/v1/internal/usage-event`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-origin-secret': env.ORIGIN_SECRET,
      },
      body: JSON.stringify({
        userId: input.userId,
        threshold: input.threshold,
        date,
        used: input.used,
        limit: input.limit,
      }),
    });
    if (!res.ok) return; // silently accept failure — API side may retry
  } catch {
    return;
  }

  try {
    // 24h TTL — resets naturally at UTC midnight when the date key changes.
    await env.KV.put(guardKey, '1', { expirationTtl: 90_000 });
  } catch {
    // non-fatal
  }
}
