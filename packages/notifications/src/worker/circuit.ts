// Circuit breaker for the Resend transport.
// If error rate crosses 50% over a 60s window with at least 10 calls, the
// circuit opens for 5 minutes — new jobs are XCLAIMed back for retry without
// hitting the provider, so we stop amplifying a provider outage.
//
// State is stored in Redis (shared across worker instances). Closed/open only;
// no half-open state — on cooldown expiry a single probe (the next job)
// attempts a send, and the window counters reset based on outcome.
import type { Redis } from 'ioredis';

const OK_KEY = 'email:circuit:resend:ok';
const FAIL_KEY = 'email:circuit:resend:fail';
const STATE_KEY = 'email:circuit:resend:state';
const WINDOW_SECONDS = 60;
const MIN_CALLS_FOR_TRIP = 10;
const FAIL_THRESHOLD = 0.5;
const COOLDOWN_MS = 5 * 60 * 1000;

export async function isCircuitOpen(redis: Redis): Promise<boolean> {
  const openUntil = await redis.get(STATE_KEY);
  if (!openUntil) return false;
  const until = Number.parseInt(openUntil, 10);
  if (!Number.isFinite(until)) return false;
  if (Date.now() >= until) {
    // cooldown expired — clear the flag so the next send probes
    await redis.del(STATE_KEY);
    await redis.del(OK_KEY);
    await redis.del(FAIL_KEY);
    return false;
  }
  return true;
}

export async function recordOutcome(redis: Redis, ok: boolean): Promise<void> {
  const key = ok ? OK_KEY : FAIL_KEY;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);

  if (!ok) {
    const [okCount, failCount] = await Promise.all([
      redis.get(OK_KEY).then((v) => Number.parseInt(v ?? '0', 10)),
      redis.get(FAIL_KEY).then((v) => Number.parseInt(v ?? '0', 10)),
    ]);
    const total = okCount + failCount;
    if (total >= MIN_CALLS_FOR_TRIP && failCount / total >= FAIL_THRESHOLD) {
      const openUntil = Date.now() + COOLDOWN_MS;
      await redis.set(STATE_KEY, String(openUntil), 'EX', Math.ceil(COOLDOWN_MS / 1000));
    }
  }
}
