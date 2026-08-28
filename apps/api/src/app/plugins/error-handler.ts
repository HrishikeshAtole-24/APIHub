/**
 * Centralised error handling (report 12.3, 20.1).
 *
 * Rules enforced here:
 *  - Clients receive `{ error: { code, message, requestId } }`, always.
 *  - Stack traces and driver messages never leave the process.
 *  - 5xx are logged with full detail; 4xx are logged at warn without noise.
 *  - Zod failures become structured, field-level validation errors.
 */
import { ERROR_CODES } from '@apihub/contracts';
import { getLogger } from '@apihub/logger';
import { CircuitOpenError } from '@apihub/runtime';
import { SsrfError } from '@apihub/security';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  AppError,
  BlockedTargetError,
  CircuitOpenAppError,
  isAppError,
  translateDatabaseError,
  ValidationError,
} from '../../shared/errors.js';
import { errorEnvelope } from '../envelope.js';

const log = getLogger('api.error');

/** Flatten a ZodError into the `details` array of the error contract. */
export function zodToDetails(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/** Map any thrown value onto an AppError. */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error as AppError;

  if (error instanceof ZodError) {
    return new ValidationError('Request validation failed', zodToDetails(error));
  }

  // The SSRF guard's rejections are user-facing and safe to explain: telling
  // someone their URL resolves to a private address is useful, and reveals
  // nothing they could not determine themselves.
  if (error instanceof SsrfError) {
    return new BlockedTargetError(error.message, error.code);
  }

  if (error instanceof CircuitOpenError) {
    return new CircuitOpenAppError(error.circuitName, Math.ceil(error.retryAfterMs / 1000));
  }

  const translated = translateDatabaseError(error);
  if (translated) return translated;

  const fastifyError = error as FastifyError;

  if (fastifyError?.validation) {
    return new ValidationError(
      'Request validation failed',
      fastifyError.validation.map((issue) => ({
        path: String(issue.instancePath || issue.schemaPath || '(root)').replace(/^\//, ''),
        message: issue.message ?? 'invalid',
      })),
    );
  }

  switch (fastifyError?.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError(ERROR_CODES.PAYLOAD_TOO_LARGE, 413, 'The request payload is too large.');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError(ERROR_CODES.VALIDATION_FAILED, 415, 'Unsupported content type.');
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return new ValidationError('A JSON body is required.');
    default:
      break;
  }

  if (typeof fastifyError?.statusCode === 'number' && fastifyError.statusCode < 500) {
    return new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      fastifyError.statusCode,
      fastifyError.message || 'Request could not be processed.',
    );
  }

  // Anything unrecognised is an internal fault. Its message is deliberately
  // generic; the real detail goes to the log, keyed by requestId.
  return new AppError(
    ERROR_CODES.INTERNAL_ERROR,
    500,
    'An unexpected error occurred. Please try again.',
  );
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const appError = normalizeError(error);

    if (appError.statusCode >= 500) {
      // Full detail, including the original error, only in the server log.
      log.error(
        {
          requestId: request.requestId,
          method: request.method,
          url: request.url,
          code: appError.code,
          err: error,
        },
        'unhandled error',
      );
    } else {
      log.warn(
        {
          requestId: request.requestId,
          method: request.method,
          url: request.url,
          code: appError.code,
          message: appError.message,
        },
        'request error',
      );
    }

    if (appError.retryAfter !== undefined) {
      void reply.header('Retry-After', String(appError.retryAfter));
    }

    return reply
      .status(appError.statusCode)
      .send(
        errorEnvelope(
          request.requestId,
          appError.code,
          appError.message,
          appError.details,
          appError.retryAfter,
        ),
      );
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .status(404)
      .send(
        errorEnvelope(
          request.requestId,
          ERROR_CODES.NOT_FOUND,
          `Route ${request.method} ${request.url} does not exist.`,
        ),
      );
  });
}
