// Simple token-bucket rate limiter backed by a single Redis key per limiter.
// Protects Resend from our own spikes — a release announcement fanout at
// 1000 users/sec would otherwise 429 and storm retries.
//
// Key: `email:ratelimit:resend:<slot>` where slot = unix-second. We increment
// via INCR (cheap, atomic, auto-expires). If INCR > ceiling, wait ~50ms and
// retry. Cap total wait so the worker doesn't freeze under sustained 429s.
import type { Redis } from 'ioredis';

export interface RateLimitOptions {
  sendsPerSecond: number;
  maxWaitMs?: number;
}

export async function acquireRateLimitToken(
  redis: Redis,
  opts: RateLimitOptions,
): Promise<boolean> {
  const maxWait = opts.maxWaitMs ?? 2000;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const slot = Math.floor(Date.now() / 1000);
    const key = `email:ratelimit:resend:${slot}`;
    const count = await redis.incr(key);
    if (count === 1) {
      // first increment in this slot — set 2s TTL so stale keys don't linger
      await redis.expire(key, 2);
    }
    if (count <= opts.sendsPerSecond) return true;
    await sleep(40 + Math.floor(Math.random() * 40));
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
