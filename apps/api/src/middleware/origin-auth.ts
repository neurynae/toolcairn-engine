import { config } from '@toolcairn/config';
import type { Context, MiddlewareHandler, Next } from 'hono';

/**
 * Validates X-Origin-Secret header so only the Cloudflare Worker
 * (or direct calls in dev/staging) can reach this API.
 *
 * If ORIGIN_SECRET is not configured the middleware is a no-op,
 * which allows direct requests during local development.
 */
export const originAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const secret = config.ORIGIN_SECRET;
  if (!secret) {
    // Dev/staging: no secret configured — allow all requests
    await next();
    return;
  }

  const provided = c.req.header('x-origin-secret');
  if (provided !== secret) {
    return c.json({ error: 'forbidden', message: 'Missing or invalid origin secret' }, 403);
  }
  await next();
};
