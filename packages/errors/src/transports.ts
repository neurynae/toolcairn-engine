import pino from 'pino';
import { errorSerializer } from './serializers.js';
import type { CreateLoggerOptions } from './logger.js';

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
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
];

/**
 * Creates a production logger that writes to two targets simultaneously:
 *
 * 1. **stdout (fd=1)** — all messages at the configured level.
 *    Captured by Docker log driver (`docker logs`, CloudWatch, etc.)
 *
 * 2. **Error log file** — warn+ messages written to a date-stamped file.
 *    Persists across container restarts via a Docker volume mount at /app/logs.
 *    File path: `{logDir}/error-YYYY-MM-DD.log`
 *
 * Use this instead of `createLogger` in Docker production entry points.
 * The log volume must be mounted: see `toolpilot_logs` in docker-compose.prod.yml.
 */
export function createProdLogger(opts: CreateLoggerOptions & { logDir?: string }): pino.Logger {
  const logDir = opts.logDir ?? process.env.LOG_DIR ?? '/app/logs';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const errorLogPath = `${logDir}/error-${today}.log`;
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';

  const transport = pino.transport({
    targets: [
      // All messages → stdout (Docker captures this)
      {
        target: 'pino/file',
        options: { destination: 1 },
        level,
      },
      // warn+ messages → persistent error file (survives container restarts)
      {
        target: 'pino/file',
        options: { destination: errorLogPath, mkdir: true },
        level: 'warn',
      },
    ],
  });

  return pino(
    {
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
      base: {
        pid: process.pid,
        hostname: process.env.HOSTNAME ?? undefined,
        ...opts.defaultFields,
      },
    },
    transport,
  );
}
