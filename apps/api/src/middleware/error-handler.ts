import { AppError } from '@toolcairn/errors';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

/**
 * Assigns a unique request ID to every inbound request.
 *
 * Priority order:
 * 1. X-Request-ID from upstream (Cloudflare Worker sets this via crypto.randomUUID())
 * 2. Freshly generated UUID if not present
 *
 * The ID is:
 * - Stored in Hono context: c.get('requestId')
 * - Echoed in the response header: X-Request-ID
 * - Available to all downstream handlers and the error handler for correlation
 */
export const requestIdMiddleware: MiddlewareHandler = async (c: Context, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
};

/**
 * Global Hono error handler — replaces the bare `app.onError`.
 *
 * Behaviour:
 * - AppError (operational): logs at severity-appropriate level, returns
 *   structured JSON with error code and message (safe to expose to clients)
 * - AppError (non-operational): logs at 'error', returns masked generic message
 * - Unknown errors: logs at 'error', returns masked generic message
 *
 * Every response includes `requestId` so clients can report the ID when
 * filing bug reports or searching logs.
 *
 * Stack traces are included in responses only in non-production environments
 * to avoid leaking implementation details to external callers.
 */
export function createErrorHandler(logger: Logger): ErrorHandler {
  return (err: Error, c: Context) => {
    const requestId = (c.get('requestId') as string | undefined) ?? 'unknown';
    const isProd = process.env.NODE_ENV === 'production';

    if (err instanceof AppError) {
      const logLevel = err.severity === 'critical' || err.severity === 'high' ? 'error' : 'warn';

      logger[logLevel](
        {
          err,
          requestId,
          method: c.req.method,
          path: c.req.path,
        },
        err.isOperational ? err.message : 'Internal application error',
      );

      return c.json(
        {
          error: err.code,
          message: err.isOperational ? err.message : 'An internal error occurred',
          requestId,
          ...(!isProd && err.stack ? { stack: err.stack } : {}),
        },
        err.httpStatus as Parameters<typeof c.json>[1],
      );
    }

    // Programmer error or an unknown throw — mask the message entirely
    logger.error(
      {
        err,
        requestId,
        method: c.req.method,
        path: c.req.path,
      },
      'Unhandled error',
    );

    return c.json(
      {
        error: 'ERR_INTERNAL',
        message: 'An internal error occurred',
        requestId,
        ...(!isProd && err instanceof Error ? { stack: err.stack } : {}),
      },
      500,
    );
  };
}
