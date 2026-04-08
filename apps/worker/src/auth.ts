import type { ApiKeyRecord, Env } from './types.js';

const AUTH_RATE_LIMIT = 300; // requests per minute for authenticated users

/**
 * Validate a request — JWT Bearer token is required.
 * Anonymous API-key-only requests are rejected; all clients must authenticate.
 */
export async function validateRequest(
  request: Request,
  env: Env,
): Promise<{ valid: boolean; record: ApiKeyRecord | null; error?: string }> {
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

  const current = Number.parseInt((await env.KV.get(rlKey)) ?? '0');
  if (current >= limit) return false;

  await env.KV.put(rlKey, String(current + 1), { expirationTtl: 120 });
  return true;
}

/**
 * Increments daily usage counter (async, non-blocking — call with ctx.waitUntil).
 */
export async function meterUsage(apiKey: string, path: string, env: Env): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const usageKey = `usage:${apiKey}:${day}`;
  const current = Number.parseInt((await env.KV.get(usageKey)) ?? '0');
  await env.KV.put(usageKey, String(current + 1), { expirationTtl: 90 * 86_400 });

  const toolKey = `usage:${apiKey}:${day}:${path.replace(/\//g, '_')}`;
  const toolCurrent = Number.parseInt((await env.KV.get(toolKey)) ?? '0');
  await env.KV.put(toolKey, String(toolCurrent + 1), { expirationTtl: 90 * 86_400 });
}
