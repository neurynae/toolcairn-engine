import { ErrorCode, type ErrorCodeValue } from './error-codes.js';
import type { ErrorContext, Severity } from './types.js';

export interface AppErrorOptions {
  code: ErrorCodeValue;
  message: string;
  /** HTTP status code to return to the client. Default: 500 */
  httpStatus?: number;
  /** How severe is this error for alerting/triage. Default: 'medium' */
  severity?: Severity;
  /**
   * Operational errors are expected conditions (validation failure, rate limit,
   * not found). Their message is safe to expose to clients.
   *
   * Non-operational errors are programmer bugs (null reference, type error).
   * Their message must be masked — only a generic "internal error" reaches clients.
   *
   * Default: true
   */
  isOperational?: boolean;
  /** The underlying error that caused this one — preserves the full chain */
  cause?: unknown;
  /** Structured context: module, operation, IDs — logged alongside the error */
  context?: ErrorContext;
}

/**
 * Base application error. All domain errors extend this.
 *
 * Carries structured metadata for:
 * - Deterministic error codes (safe to log, persist, return to clients)
 * - Severity-based alerting
 * - Operational vs programmer error distinction
 * - Rich context for debugging (module, operation, IDs)
 * - Full cause chain via Error.cause (ES2022)
 */
export class AppError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly httpStatus: number;
  public readonly severity: Severity;
  public readonly isOperational: boolean;
  public readonly context: ErrorContext;
  public readonly timestamp: string;

  constructor(opts: AppErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = this.constructor.name;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus ?? 500;
    this.severity = opts.severity ?? 'medium';
    this.isOperational = opts.isOperational ?? true;
    this.context = opts.context ?? {};
    this.timestamp = new Date().toISOString();

    // Restore correct prototype chain — required for `instanceof` checks to
    // work correctly when compiling to CommonJS with TypeScript.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Structured JSON representation used by the pino error serializer */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      severity: this.severity,
      isOperational: this.isOperational,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
      cause:
        this.cause instanceof Error
          ? { name: this.cause.name, message: this.cause.message, stack: this.cause.stack }
          : this.cause,
    };
  }
}

// ── Domain error classes ──────────────────────────────────────────────────────
// Each sets sensible defaults so call sites stay concise.

export class DatabaseError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_DB_QUERY,
      message: opts.message,
      httpStatus: 503,
      severity: 'high',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class NetworkError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_NETWORK_TIMEOUT,
      message: opts.message,
      httpStatus: 502,
      severity: 'high',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class ValidationError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_VALIDATION_INPUT,
      message: opts.message,
      httpStatus: 400,
      severity: 'low',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class AuthError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_AUTH_UNAUTHORIZED,
      message: opts.message,
      httpStatus: 401,
      severity: 'medium',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class ExternalServiceError extends AppError {
  constructor(opts: {
    service: string;
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_INTERNAL,
      message: `[${opts.service}] ${opts.message}`,
      httpStatus: 502,
      severity: 'high',
      isOperational: true,
      cause: opts.cause,
      context: { ...opts.context, service: opts.service },
    });
  }
}

export class QueueError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_QUEUE_PUBLISH,
      message: opts.message,
      httpStatus: 503,
      severity: 'high',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class SearchError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_SEARCH_PIPELINE,
      message: opts.message,
      httpStatus: 500,
      severity: 'medium',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class IndexerError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_INDEXER_PROCESS,
      message: opts.message,
      httpStatus: 500,
      severity: 'medium',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class VectorError extends AppError {
  constructor(opts: {
    code?: ErrorCodeValue;
    message: string;
    cause?: unknown;
    context?: ErrorContext;
  }) {
    super({
      code: opts.code ?? ErrorCode.ERR_EXTERNAL_NOMIC,
      message: opts.message,
      httpStatus: 502,
      severity: 'high',
      isOperational: true,
      cause: opts.cause,
      context: opts.context,
    });
  }
}
