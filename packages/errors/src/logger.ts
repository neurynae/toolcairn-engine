import pino, { type Logger, type LoggerOptions } from 'pino';
import { errorSerializer } from './serializers.js';

/**
 * Sensitive fields that must never appear in log output.
 * Pino's redaction replaces the field value with '[REDACTED]'.
 */
const REDACT_PATHS = [
  'password',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'apiKey',
  'api_key',
  'secret',
  'ORIGIN_SECRET',
  'ADMIN_SECRET',
  'AUTH_SECRET',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'NOMIC_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_TOKEN_2',
  'authorization',
  'cookie',
  // Email PII — redacted so bounce/complaint events don't leak recipient addresses
  // into shipped logs (Resend webhooks echo the full email).
  'to',
  'toEmail',
  'email',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.email',
  '*.toEmail',
  'user.email',
  'payload.email',
  'payload.toEmail',
];

export interface CreateLoggerOptions {
  /** Module name used in every log line, e.g. '@toolcairn/graph' */
  name: string;
  /** Override the environment-driven log level */
  level?: string;
  /** Additional fields merged into every log line's base object */
  defaultFields?: Record<string, unknown>;
}

/**
 * Creates a pino logger configured for ToolCairn services.
 *
 * Features over bare `pino({ name })`:
 * - Custom error serializer extracts AppError metadata into structured fields
 * - Sensitive field redaction (tokens, secrets, API keys)
 * - Environment-aware log level (LOG_LEVEL env var → 'debug' in dev → 'info' in prod)
 * - Structured JSON output suitable for Docker log drivers and log aggregators
 *
 * Usage:
 *   const logger = createLogger({ name: '@toolcairn/graph' });
 *   const child = logger.child({ operation: 'createTool', toolId: '...' });
 *   child.error({ err }, 'Failed to create tool');
 *
 * For human-readable dev output, pipe through pino-pretty:
 *   pnpm dev | pnpm exec pino-pretty
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const level =
    opts.level ??
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV !== 'production' ? 'debug' : 'info');

  const pinoOpts: LoggerOptions = {
    name: opts.name,
    level,
    serializers: {
      err: errorSerializer,
      error: errorSerializer,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(opts.defaultFields
      ? {
          base: {
            pid: process.pid,
            hostname: process.env.HOSTNAME ?? undefined,
            ...opts.defaultFields,
          },
        }
      : {
          base: {
            pid: process.pid,
            hostname: process.env.HOSTNAME ?? undefined,
          },
        }),
  };

  return pino(pinoOpts);
}
