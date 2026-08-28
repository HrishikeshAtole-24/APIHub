/**
 * Health monitoring routes (report 32, FR-08).
 */
import { HealthQuerySchema, SlugSchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Container } from '../app/container.js';
import { sendCacheable } from '../app/envelope.js';

const SlugParams = z.object({ slug: SlugSchema });
const BoardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  status: z.enum(['up', 'degraded', 'down', 'unknown']).optional(),
});

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Platform-wide status board. */
  app.get('/health/board', async (request, reply) => {
    const { limit, status } = BoardQuery.parse(request.query);
    const board = await container.health.board(limit, status);
    return sendCacheable(request, reply, board, 60);
  });

  app.get('/health/incidents', async (request, reply) => {
    const incidents = await container.health.openIncidents(20);
    return sendCacheable(request, reply, incidents, 60);
  });

  /** Full health report for one API: uptime history, incidents, sparkline. */
  app.get('/apis/:slug/health', async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const { days } = HealthQuerySchema.parse(request.query);

    const api = await container.catalog.getBySlug(slug);
    const report = await container.health.report(api.id, days);

    return sendCacheable(request, reply, report, 120);
  });
}
