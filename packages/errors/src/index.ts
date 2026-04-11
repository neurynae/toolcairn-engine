export { ErrorCode, type ErrorCodeValue } from './error-codes.js';
export type { ErrorContext, Severity } from './types.js';
export {
  AppError,
  type AppErrorOptions,
  DatabaseError,
  NetworkError,
  ValidationError,
  AuthError,
  ExternalServiceError,
  QueueError,
  SearchError,
  IndexerError,
  VectorError,
} from './errors.js';
export { errorSerializer } from './serializers.js';
export { createLogger, type CreateLoggerOptions } from './logger.js';
