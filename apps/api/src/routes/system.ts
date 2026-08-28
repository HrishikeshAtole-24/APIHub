/**
 * Operational endpoints (report 27, 37 Milestone A).
 *
 * Unversioned and unauthenticated by design: orchestrators, load balancers and
 * scrapers need stable, dependency-free paths. They are excluded from rate
 * limiting so a probe can never be throttled into reporting a false outage.
 */
import { metrics } from '@apihub/runtime';
import type { FastifyInstance } from 'fastify';

import type { Container } from '../app/container.js';

export async function registerSystemRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Liveness: is the process running? Deliberately does no I/O. */
  app.get('/healthz', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ status: 'ok' });
  });

  /**
   * Readiness: can this instance serve traffic?
   *
   * 503 when the database is unreachable, so a load balancer removes the
   * instance instead of routing requests that are guaranteed to fail.
   * "degraded" (cache down) still returns 200: the platform works without Redis.
   */
  app.get('/readyz', async (_request, reply) => {
    const result = await container.admin.healthz();
    const status = result.status === 'error' ? 503 : 200;
    return reply.header('Cache-Control', 'no-store').status(status).send(result);
  });

  /** Prometheus scrape endpoint. */
  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(metrics.toPrometheus());
  });

  /** Minimal service descriptor, useful for smoke tests after deploy. */
  app.get('/', async (_request, reply) => {
    return reply.send({
      name: 'APIHub API',
      version: process.env['npm_package_version'] ?? '0.1.0',
      documentation: '/v1',
      endpoints: ['/v1/apis', '/v1/search', '/v1/categories', '/v1/health/board'],
    });
  });
}
