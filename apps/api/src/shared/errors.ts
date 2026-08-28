/**
 * Application error hierarchy (report 12.3).
 *
 * Every error that reaches the client is an `AppError` with a machine-readable
 * code, an HTTP status and a message written for a developer to read. Anything
 * else is treated as an unexpected internal error and its details are NOT
 * exposed — report 12.3: "never expose stack traces to clients".
 */
import { ERROR_CODES, type ErrorCode } from '@apihub/contracts';

export class AppError extends Error {
  readonly isAppError = true;

  constructor(
    readonly code: ErrorCode | string,
    readonly statusCode: number,
    message: string,
    readonly details?: { path: string; message: string }[],
    /** Seconds the client should wait before retrying. Sets Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }

  /** True when this represents a client mistake rather than a server fault. */
  get isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: { path: string; message: string }[]) {
    super(ERROR_CODES.VALIDATION_FAILED, 400, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(ERROR_CODES.UNAUTHORIZED, 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(ERROR_CODES.FORBIDDEN, 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', code: ErrorCode = ERROR_CODES.NOT_FOUND) {
    super(code, 404, `${resource} was not found.`);
  }
}

export class ApiNotFoundError extends NotFoundError {
  constructor(slug?: string) {
    super(slug ? `API "${slug}"` : 'API', ERROR_CODES.API_NOT_FOUND);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That resource already exists.') {
    super(ERROR_CODES.CONFLICT, 409, message);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number, message = 'Too many requests. Please slow down.') {
    super(ERROR_CODES.RATE_LIMITED, 429, message, undefined, retryAfterSeconds);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'The request payload is too large.') {
    super(ERROR_CODES.PAYLOAD_TOO_LARGE, 413, message);
  }
}

/**
 * The playground/probe target was rejected by the SSRF guard.
 *
 * 400, not 403: the request itself is invalid, and the distinction matters
 * because a 403 would suggest the user could gain access with credentials.
 */
export class BlockedTargetError extends AppError {
  constructor(message: string, readonly reason?: string) {
    super(ERROR_CODES.BLOCKED_TARGET, 400, message);
  }
}

export class UpstreamTimeoutError extends AppError {
  constructor(timeoutMs: number) {
    super(
      ERROR_CODES.UPSTREAM_TIMEOUT,
      504,
      `The upstream API did not respond within ${timeoutMs}ms.`,
    );
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, readonly upstreamStatus?: number) {
    super(ERROR_CODES.UPSTREAM_ERROR, 502, message);
  }
}

export class CircuitOpenAppError extends AppError {
  constructor(host: string, retryAfterSeconds: number) {
    super(
      ERROR_CODES.CIRCUIT_OPEN,
      503,
      `${host} is currently failing and has been temporarily suspended.`,
      undefined,
      retryAfterSeconds,
    );
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable.', retryAfterSeconds = 30) {
    super(ERROR_CODES.SERVICE_UNAVAILABLE, 503, message, undefined, retryAfterSeconds);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError || (typeof error === 'object' && error !== null && 'isAppError' in error);
}

/**
 * Translate a database driver error into a domain error.
 *
 * PostgreSQL error codes are stable across drivers, so this handles the
 * constraint violations the schema deliberately relies on rather than
 * duplicating those checks in application code.
 */
export function translateDatabaseError(error: unknown): AppError | null {
  const code = (error as { code?: string })?.code;
  const detail = (error as { detail?: string })?.detail ?? '';

  switch (code) {
    case '23505': // unique_violation
      return new ConflictError(friendlyUniqueMessage(detail));
    case '23503': // foreign_key_violation
      return new ValidationError('A referenced record does not exist.');
    case '23514': // check_violation
      return new ValidationError('A value violates a database constraint.');
    case '22001': // string_data_right_truncation
      return new ValidationError('A submitted value is too long.');
    case '40001': // serialization_failure
      return new ServiceUnavailableError('Conflicting concurrent update; please retry.', 1);
    case '57014': // query_canceled
      return new ServiceUnavailableError('The query took too long and was cancelled.');
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return new ServiceUnavailableError('The database is unreachable.');
    default:
      return null;
  }
}

function friendlyUniqueMessage(detail: string): string {
  if (detail.includes('email')) return 'An account with that email already exists.';
  if (detail.includes('slug')) return 'That name is already taken.';
  if (detail.includes('reviews_user_api')) return 'You have already reviewed this API.';
  if (detail.includes('favorites')) return 'That API is already in your favorites.';
  return 'That resource already exists.';
}
