/**
 * ToolCairn API Gateway — Cloudflare Worker
 *
 * Sits in front of the VPS API at origin.toolcairn.neurynae.com.
 * Handles: auth, rate limiting (per-minute + daily), POST caching, usage metering.
 *
 * Flow per request:
 *   1. Validate API key / JWT
 *   2. Per-minute rate limit check
 *   3. Daily limit check (free: 100–200 dynamic, pro: 5000)
 *   4. Cache check (for cacheable POST endpoints)
 *   5. Forward to VPS origin
 *   6. Cache response + meter usage (async)
 *
 * Cron (every minute):
 *   - Fetches /v1/system/load from VPS and writes free_tier_limit to KV
 */
import { checkDailyLimit, checkRateLimit, meterUsage, validateRequest } from './auth.js';
import { getCached, isCacheable, putCached } from './cache.js';
import { notifyUsageEvent } from './notify.js';
import type { Env } from './types.js';

// biome-ignore lint/style/noDefaultExport: Cloudflare Workers require default export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-ToolPilot-Key, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── Health check — no auth required ────────────────────────────────────
    if (path === '/v1/health' && request.method === 'GET') {
      return Response.json({
        ok: true,
        service: 'toolcairn-gateway',
        ts: new Date().toISOString(),
      });
    }

    // ── System load — public (fetched by CF cron + status page) ────────────
    if (path === '/v1/system/load' && request.method === 'GET') {
      return forwardToOrigin(request, env, path);
    }

    // ── Registration — no auth required (creates the key) ──────────────────
    if (path === '/v1/register' && request.method === 'POST') {
      return forwardToOrigin(request, env, path);
    }

    // ── Admin routes — bypass API key, use JWT auth instead ────────────────
    if (path.startsWith('/v1/admin/') || path === '/v1/admin') {
      return forwardToOrigin(request, env, path);
    }

    // ── Auth routes — no API key required (device code flow, signup, token) ──
    if (path.startsWith('/v1/auth/')) {
      return forwardToOrigin(request, env, path);
    }

    // ── Billing webhook — no API key required (comes from Razorpay) ─────────
    if (path === '/v1/billing/webhook' && request.method === 'POST') {
      return forwardToOrigin(request, env, path);
    }

    // ── External provider webhooks — signature-verified by the handler itself
    if (path.startsWith('/v1/webhooks/')) {
      return forwardToOrigin(request, env, path);
    }

    // ── Public waitlist / unsubscribe — token-gated, no API key required ────
    if (path === '/v1/waitlist/join' || path === '/v1/email/unsubscribe') {
      return forwardToOrigin(request, env, path);
    }

    // ── SVG badges — public, no auth (embedded in READMEs) ──────────────────
    if (path.startsWith('/v1/badge/')) {
      return forwardToOrigin(request, env, path);
    }

    // ── API Key + JWT validation ────────────────────────────────────────────
    const { valid, record, error } = await validateRequest(request, env);
    if (!valid || !record) {
      return Response.json(
        {
          ok: false,
          error: error ?? 'authentication_required',
          message:
            error === 'token_expired'
              ? 'Your session has expired. Restart your agent to sign in again.'
              : 'Authentication required. Restart your agent — sign-in starts automatically.',
        },
        { status: 401 },
      );
    }

    // ── Per-minute rate limit ───────────────────────────────────────────────
    const withinMinuteLimit = await checkRateLimit(record.client_id, record.rate_limit, env);
    if (!withinMinuteLimit) {
      return Response.json(
        {
          ok: false,
          error: 'rate_limited',
          message: `Rate limit exceeded (${record.rate_limit} requests/min on ${record.tier} tier). Slow down or upgrade.`,
          tier: record.tier,
        },
        {
          status: 429,
          headers: {
            'Retry-After': '60',
            'X-RateLimit-Limit': String(record.rate_limit),
            'X-RateLimit-Tier': record.tier,
          },
        },
      );
    }

    // ── Daily limit check ───────────────────────────────────────────────────
    const daily = await checkDailyLimit(record.client_id, record.tier, env);

    // ── Threshold-crossing notification (async, best-effort) ───────────────
    // Fire a fire-and-forget callback to the API when the user crosses 90% or 100%.
    // The API-side handler dedupes via EmailEvent UNIQUE on (userId, kind, date).
    // We skip anonymous/service keys (no userId → no email target).
    if (record.user_id && record.user_id !== 'web-app-service' && daily.limit > 0) {
      const pctBefore = (daily.used - 1) / daily.limit; // best-effort: we don't know the "pre" exactly
      const pctNow = daily.used / daily.limit;
      if (pctNow >= 1.0) {
        ctx.waitUntil(
          notifyUsageEvent(env, {
            userId: record.user_id,
            used: daily.used,
            limit: daily.limit,
            threshold: 100,
          }),
        );
      } else if (pctNow >= 0.9 && pctBefore < 0.9) {
        ctx.waitUntil(
          notifyUsageEvent(env, {
            userId: record.user_id,
            used: daily.used,
            limit: daily.limit,
            threshold: 90,
          }),
        );
      }
    }

    if (!daily.allowed) {
      return Response.json(
        {
          ok: false,
          error: 'daily_limit_exceeded',
          message: `You've used ${daily.used}/${daily.limit} calls today. Upgrade to Pro for 5,000 calls/day.`,
          used: daily.used,
          limit: daily.limit,
          tier: record.tier,
          upgrade_url: 'https://toolcairn.neurynae.com/billing',
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Daily-Limit': String(daily.limit),
            'X-RateLimit-Daily-Used': String(daily.used),
            'X-RateLimit-Daily-Remaining': '0',
            'X-RateLimit-Tier': record.tier,
          },
        },
      );
    }

    // ── Meter usage (async — never block the response) ─────────────────────
    ctx.waitUntil(meterUsage(record.client_id, path, env));

    // ── Cache check (POST responses for cacheable endpoints) ────────────────
    if (request.method === 'POST' && isCacheable(path)) {
      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        body = {};
      }

      const cached = await getCached(path, body);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set('X-Cache', 'HIT');
        hit.headers.set('X-Cache-Path', path);
        appendRateLimitHeaders(hit.headers, record.tier, daily);
        return hit;
      }

      const originResponse = await forwardToOrigin(request, env, path, record.user_id);
      if (originResponse.ok) {
        ctx.waitUntil(putCached(path, body, originResponse.clone()));
      }
      const miss = new Response(originResponse.body, originResponse);
      miss.headers.set('X-Cache', 'MISS');
      appendRateLimitHeaders(miss.headers, record.tier, daily);
      return miss;
    }

    // ── Non-cacheable: forward directly ────────────────────────────────────
    const response = await forwardToOrigin(request, env, path, record.user_id);
    const result = new Response(response.body, response);
    appendRateLimitHeaders(result.headers, record.tier, daily);
    return result;
  },

  // Cron trigger — runs every minute.
  // Fetches the VPS load snapshot and caches free_tier_limit in KV so the
  // fetch handler can read it without a network call.
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const res = await fetch(`${env.API_ORIGIN_URL.replace(/\/$/, '')}/v1/system/load`, {
        headers: { 'X-Origin-Secret': env.ORIGIN_SECRET },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { ok: boolean; data?: { free_tier_limit?: number } };
      const limit = json.data?.free_tier_limit ?? 200;
      await env.KV.put('system:free_tier_limit', String(limit), { expirationTtl: 300 });
    } catch {
      // Non-fatal — stale KV value is fine for one missed cycle
    }
  },
};

function appendRateLimitHeaders(
  headers: Headers,
  tier: string,
  daily: { used: number; limit: number },
): void {
  headers.set('X-RateLimit-Daily-Limit', String(daily.limit));
  headers.set('X-RateLimit-Daily-Used', String(daily.used));
  headers.set('X-RateLimit-Daily-Remaining', String(Math.max(0, daily.limit - daily.used)));
  headers.set('X-RateLimit-Tier', tier);
}

async function forwardToOrigin(
  request: Request,
  env: Env,
  path: string,
  userId?: string,
): Promise<Response> {
  const search = new URL(request.url).search;
  const originUrl = env.API_ORIGIN_URL.replace(/\/$/, '') + path + search;

  const headers = new Headers(request.headers);
  headers.set('X-Origin-Secret', env.ORIGIN_SECRET);
  // Preserve caller's X-ToolCairn-User-Id if already set (e.g. Vercel web app sets
  // the real user ID for user-specific endpoints like billing/status).
  // Only inject worker-derived userId if the caller didn't supply one.
  const callerUserId = request.headers.get('X-ToolCairn-User-Id');
  if (callerUserId) {
    headers.set('X-ToolCairn-User-Id', callerUserId);
  } else if (userId) {
    headers.set('X-ToolCairn-User-Id', userId);
  }
  headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') ?? 'unknown');
  headers.delete('X-ToolPilot-Key');

  try {
    const response = await fetch(originUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    });

    const result = new Response(response.body, response);
    result.headers.set('Access-Control-Allow-Origin', '*');
    result.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    result.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, X-ToolPilot-Key, Authorization',
    );
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return Response.json(
      { ok: false, error: 'origin_unreachable', message: `VPS origin unreachable: ${msg}` },
      { status: 503 },
    );
  }
}
