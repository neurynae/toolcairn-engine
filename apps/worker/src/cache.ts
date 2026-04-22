/**
 * POST request caching via Cloudflare Cache API.
 * Cache key = SHA-256 of (path + sorted JSON body).
 * Cloudflare doesn't cache POST by default — we use the Cache API to handle it.
 */

/** Endpoints that are safe to cache and their TTL in seconds.
 * /v1/search is intentionally excluded — responses are session-specific,
 * state-dependent (Stage 0, clarification round), and must always reach
 * the API to fire the exact-match short-circuit and credibility ranking.
 */
const CACHEABLE: Record<string, number> = {
  '/v1/graph/compatibility': 86_400, // 24 hours
  '/v1/graph/compare': 21_600, // 6 hours
  '/v1/graph/stack': 21_600, // 6 hours
  '/v1/intelligence/refine': 86_400, // 24 hours
  // Tool name → canonical metadata changes rarely; discovery hits this per
  // session so the batch-body key hashes well for repeat runs on the same project.
  '/v1/tools/batch-resolve': 86_400, // 24 hours
};

export function isCacheable(path: string): boolean {
  return path in CACHEABLE;
}

export function getCacheTtl(path: string): number {
  return CACHEABLE[path] ?? 3600;
}

async function sha256(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build a stable cache key from path + body.
 * We sort JSON keys so {a:1, b:2} and {b:2, a:1} produce the same key.
 */
async function buildCacheKey(path: string, body: unknown): Promise<Request> {
  const sorted = JSON.stringify(body, Object.keys(body as object).sort());
  const hash = await sha256(path + sorted);
  // Use a GET request to a fake URL as cache key (Cache API only caches GET)
  return new Request(`https://cache.toolcairn.internal${path}/${hash}`, { method: 'GET' });
}

/** Check cache for this request. Returns cached Response or null. */
export async function getCached(path: string, body: unknown): Promise<Response | null> {
  const cacheKey = await buildCacheKey(path, body);
  const cache = caches.default;
  return (await cache.match(cacheKey)) ?? null;
}

/** Store response in cache with appropriate TTL. Fire-and-forget via waitUntil. */
export async function putCached(path: string, body: unknown, response: Response): Promise<void> {
  const cacheKey = await buildCacheKey(path, body);
  const ttl = getCacheTtl(path);

  // Clone with cache-control header so Cloudflare respects the TTL
  const toCache = new Response(response.body, response);
  toCache.headers.set('Cache-Control', `public, max-age=${ttl}, stale-while-revalidate=${ttl}`);
  toCache.headers.set('X-Cache', 'HIT');
  toCache.headers.set('X-Cache-TTL', String(ttl));

  await caches.default.put(cacheKey, toCache);
}
