/**
 * Request correlation and access logging (report 27.1, 27.3).
 *
 * Every request gets an id that is:
 *   - accepted from `X-Request-ID` when the caller supplies one (so a trace
 *     started in the browser continues through the API and into workers),
 *   - generated when it does not,
 *   - attached to the logger, the response envelope and the response headers.
 *
 * A caller-supplied id is sanitised before use: it ends up in log files, so an
 * unvalidated value would allow log injection.
 */
import { randomUUID } from 'node:crypto';

import { REQUEST_ID_HEADER } from '@apihub/config';
import { getLogger } from '@apihub/logger';
import { metrics } from '@apihub/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const log = getLogger('api.http');

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startedAt: number;
    /** Client IP, honouring a trusted proxy header when configured. */
    clientIp: string;
  }
}

/** Accept only a short, safe subset of characters for a caller-supplied id. */
function sanitizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 64);
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null;
}

/** Routes that are too noisy to log at info level. */
const QUIET_ROUTES = new Set(['/healthz', '/readyz', '/metrics']);

export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest('requestId', '');
  app.decorateRequest('startedAt', 0);
  app.decorateRequest('clientIp', '');

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = sanitizeRequestId(request.headers[REQUEST_ID_HEADER]);
    request.requestId = supplied ?? `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    request.startedAt = performance.now();
    request.clientIp = request.ip;

    // Echo it back so the browser can surface it in a bug report.
    void reply.header(REQUEST_ID_HEADER, request.requestId);

    // Bind the id to this request's logger; every subsequent log line carries it.
    request.log = request.log.child({ requestId: request.requestId });
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const durationMs = performance.now() - request.startedAt;
    const route = request.routeOptions?.url ?? request.url;
    const status = reply.statusCode;

    // Record against the ROUTE PATTERN, not the concrete URL: labelling by
    // `/v1/apis/openweather` would create unbounded metric cardinality.
    metrics.increment('http_requests_total', 1, {
      method: request.method,
      route,
      status: String(status),
    });
    metrics.observe('http_request_duration_ms', durationMs, { method: request.method, route });

    if (status >= 500) metrics.increment('http_errors_total', 1, { route });

    const isQuiet = QUIET_ROUTES.has(route) && status < 400;
    if (isQuiet) return;

    const payload = {
      method: request.method,
      url: request.url,
      route,
      status,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: request.clientIp,
    };

    if (status >= 500) log.error(payload, 'request failed');
    else if (status >= 400) log.warn(payload, 'request rejected');
    else log.info(payload, 'request completed');
  });
}
