/**
 * Response envelope helpers (report 12.2 / 12.3).
 *
 * Every successful response is `{ data, meta }` and every failure is
 * `{ error: { code, message, requestId } }`. Enforcing that in one place means
 * no route can accidentally return a bare object and break client parsing.
 */
import type {
  ErrorEnvelope,
  PaginationMeta,
  ResponseMeta,
  SuccessEnvelope,
} from '@apihub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Build a success envelope from a request context. */
export function ok<T>(
  request: FastifyRequest,
  data: T,
  extra?: Partial<ResponseMeta>,
): SuccessEnvelope<T> {
  return {
    data,
    meta: {
      requestId: request.requestId,
      durationMs: Math.round(performance.now() - request.startedAt),
      ...extra,
    },
  };
}

/** Success envelope including pagination metadata. */
export function paginated<T>(
  request: FastifyRequest,
  items: T[],
  pagination: PaginationMeta,
  extra?: Partial<ResponseMeta>,
): SuccessEnvelope<T[]> {
  return ok(request, items, { ...pagination, ...extra });
}

export function errorEnvelope(
  requestId: string,
  code: string,
  message: string,
  details?: { path: string; message: string }[],
  retryAfter?: number,
): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = { code, message, requestId };
  if (details && details.length > 0) error.details = details;
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  return { error };
}

/**
 * Send a response with cache headers appropriate to public catalogue data.
 *
 * `stale-while-revalidate` lets a CDN serve slightly stale content while it
 * refreshes in the background, which is the right trade-off for a catalogue
 * whose data changes on an ingestion cycle, not per request (report 24).
 */
export function sendCacheable<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  data: T,
  maxAgeSeconds: number,
  extra?: Partial<ResponseMeta>,
): FastifyReply {
  return reply
    .header(
      'Cache-Control',
      `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${Math.max(60, maxAgeSeconds)}`,
    )
    .send(ok(request, data, extra));
}

/** Send a response that must never be stored by a shared cache. */
export function sendPrivate<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  data: T,
  extra?: Partial<ResponseMeta>,
): FastifyReply {
  return reply
    .header('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
    .header('Vary', 'Cookie')
    .send(ok(request, data, extra));
}
