import { config } from '@toolcairn/config';
import type { MiddlewareHandler } from 'hono';
/**
 * Admin JWT middleware for Hono.
 * Validates the Authorization: Bearer <token> header using the same
 * HS256 JWT logic as the web app's admin auth.
 */
import { jwtVerify } from 'jose';

export const adminAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  const secret = config.ADMIN_SECRET ?? '';
  if (!secret) {
    // No secret configured — allow in dev mode
    await next();
    return;
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    await next();
  } catch {
    return c.json({ ok: false, error: 'INVALID_TOKEN' }, 401);
  }
};
