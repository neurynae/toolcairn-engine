import { AppError } from './errors.js';

/**
 * Custom pino error serializer.
 *
 * When pino logs an object with an `err` or `error` field, it runs it through
 * this serializer. AppError instances get full structured metadata extracted.
 * Plain Error instances get standard fields. Non-Error values are stringified.
 *
 * Usage in logger options:
 *   serializers: { err: errorSerializer, error: errorSerializer }
 */
export function errorSerializer(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return err.toJSON();
  }

  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause:
        err.cause instanceof Error
          ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
          : err.cause,
    };
  }

  return { message: String(err) };
}
