import type { ApiKeyRecord, Env } from './types.js';

const AUTH_RATE_LIMIT = 300; // requests per minute for authenticated users

const SERVICE_RATE_LIMIT = 600; // requests per minute for web app service auth

/**
 * Validate a request.
 *
 * Two auth paths:
 *   1. Service auth (web app → CF Worker): x-toolpilot-key header matching ORIGIN_SECRET.
 *      Used by the Vercel web app proxy; key is stripped and replaced with X-Origin-Secret
 *      before forwarding to VPS origin. Safe over HTTPS.
 *   2. User auth (MCP clients): Authorization: Bearer {JWT} signed with AUTH_SECRET.
 */
export async function validateRequest(
  request: Request,
  env: Env,
): Promise<{ valid: boolean; record: ApiKeyRecord | null; error?: string }> {
  // ── Service auth: web app sends x-toolpilot-key === ORIGIN_SECRET ──────────
  const serviceKey = request.headers.get('x-toolpilot-key');
  if (serviceKey && env.ORIGIN_SECRET && serviceKey === env.ORIGIN_SECRET) {
    const record: ApiKeyRecord = {
      client_id: 'web-app-service',
      tier: 'pro',
      rate_limit: SERVICE_RATE_LIMIT,
      created_at: new Date().toISOString(),
      user_id: 'web-app-service',
    };
    return { valid: true, record };
  }

  // ── User auth: MCP clients send JWT Bearer token ────────────────────────────
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return {
      valid: false,
      record: null,
      error: 'authentication_required',
    };
  }

  if (!env.AUTH_SECRET) {
    // AUTH_SECRET not configured — fail safe
    return { valid: false, record: null, error: 'server_misconfigured' };
  }

  const token = authHeader.slice(7);
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) throw new Error('malformed');

    // Verify HS256 signature using Web Crypto (available in CF Workers)
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.AUTH_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!valid) throw new Error('invalid_signature');

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string;
      exp?: number;
      tier?: string;
    };

    if (payload.exp && payload.exp < Date.now() / 1000) throw new Error('token_expired');

    const apiKey = request.headers.get('x-toolcairn-key') ?? (payload.sub as string);
    const record: ApiKeyRecord = {
      client_id: apiKey,
      tier: (payload.tier as 'free' | 'pro' | 'team') ?? 'free',
      rate_limit: AUTH_RATE_LIMIT,
      created_at: new Date().toISOString(),
      user_id: payload.sub as string,
    };
    return { valid: true, record };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid_token';
    return { valid: false, record: null, error: msg };
  }
}

/**
 * Checks and increments rate limit counter for an API key.
 * Uses per-minute windows stored in KV.
 */
export async function checkRateLimit(apiKey: string, limit: number, env: Env): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const rlKey = `rl:${apiKey}:${minute}`;

  try {
    const current = Number.parseInt((await env.KV.get(rlKey)) ?? '0');
    if (current >= limit) return false;
    await env.KV.put(rlKey, String(current + 1), { expirationTtl: 120 });
  } catch {
    // KV unavailable or write limit hit — degrade gracefully, allow the request
  }
  return true;
}

/**
 * Checks the daily call limit for an API key.
 * Free tier: dynamic limit (100–200) read from KV `system:free_tier_limit`.
 * Pro/team tier: fixed higher limits.
 * Returns { allowed, used, limit }.
 */
export async function checkDailyLimit(
  apiKey: string,
  tier: string,
  env: Env,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  try {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const usageKey = `usage:${apiKey}:${day}`;
    const used = Number.parseInt((await env.KV.get(usageKey)) ?? '0');

    let limit: number;
    if (tier === 'pro' || tier === 'team') {
      limit = tier === 'team' ? 20_000 : 5_000;
    } else {
      // Free tier: dynamic limit computed by the load monitor on the VPS
      limit = Number.parseInt((await env.KV.get('system:free_tier_limit')) ?? '200');
    }

    return { allowed: used < limit, used, limit };
  } catch {
    // KV unavailable — degrade gracefully, allow the request
    return { allowed: true, used: 0, limit: 200 };
  }
}

/**
 * Increments daily usage counter (async, non-blocking — call with ctx.waitUntil).
 */
export async function meterUsage(apiKey: string, path: string, env: Env): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const usageKey = `usage:${apiKey}:${day}`;
    const current = Number.parseInt((await env.KV.get(usageKey)) ?? '0');
    await env.KV.put(usageKey, String(current + 1), { expirationTtl: 90 * 86_400 });

    const toolKey = `usage:${apiKey}:${day}:${path.replace(/\//g, '_')}`;
    const toolCurrent = Number.parseInt((await env.KV.get(toolKey)) ?? '0');
    await env.KV.put(toolKey, String(toolCurrent + 1), { expirationTtl: 90 * 86_400 });
  } catch {
    // KV unavailable or write limit hit — non-fatal, skip metering
  }
}
