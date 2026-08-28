/**
 * Admin routes (report FR-10, 32, 19).
 *
 * Every route requires the admin or moderator role, carries a strict rate
 * limit, and records an audit entry for state-changing actions.
 */
import { TriggerIngestionSchema, UpdateApiStatusSchema, SlugSchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Container } from '../app/container.js';
import { sendPrivate } from '../app/envelope.js';
import { requireCsrf, requireRole } from '../app/plugins/auth.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

const SlugParams = z.object({ slug: SlugSchema });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) });

export async function registerAdminRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const adminRead = { preHandler: [requireRole('admin'), rateLimit('admin')] };
  const adminWrite = { preHandler: [requireRole('admin'), requireCsrf, rateLimit('admin')] };
  const moderatorWrite = { preHandler: [requireRole('moderator'), requireCsrf, rateLimit('admin')] };

  app.get('/admin/health', adminRead, async (request, reply) => {
    const ops = await container.admin.opsMetrics();
    return sendPrivate(request, reply, ops);
  });

  app.get('/admin/ingestion', adminRead, async (request, reply) => {
    const { limit } = LimitQuery.parse(request.query);
    const runs = await container.admin.listIngestionRuns(limit);
    return sendPrivate(request, reply, runs);
  });

  app.post('/admin/ingestion', adminWrite, async (request, reply) => {
    const input = TriggerIngestionSchema.parse(request.body ?? {});
    const result = await container.admin.triggerIngestion(input);

    await container.admin.audit({
      actorId: request.user!.id,
      actorEmail: request.user!.email,
      action: 'ingestion.triggered',
      entityType: 'ingestion',
      entityId: result.jobId,
      metadata: { ...input },
      ipAddress: request.clientIp,
    });

    return reply.status(202).send({ data: result, meta: { requestId: request.requestId } });
  });

  app.post('/admin/reindex', adminWrite, async (request, reply) => {
    const result = await container.admin.triggerReindex();
    await container.admin.audit({
      actorId: request.user!.id,
      actorEmail: request.user!.email,
      action: 'search.reindex_triggered',
      entityType: 'search',
      entityId: result.jobId,
      ipAddress: request.clientIp,
    });
    return reply.status(202).send({ data: result, meta: { requestId: request.requestId } });
  });

  app.patch('/admin/apis/:slug/status', moderatorWrite, async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const input = UpdateApiStatusSchema.parse(request.body);

    await container.admin.updateApiStatus(
      slug,
      input.status,
      { id: request.user!.id, email: request.user!.email },
      input.reason,
    );

    return sendPrivate(request, reply, { slug, status: input.status });
  });

  app.get('/admin/audit', adminRead, async (request, reply) => {
    const { limit } = LimitQuery.parse(request.query);
    const logs = await container.admin.listAuditLogs(limit);
    return sendPrivate(request, reply, logs);
  });

  app.get('/admin/analytics', adminRead, async (request, reply) => {
    const days = z.coerce.number().int().min(1).max(90).default(14)
      .parse((request.query as { days?: string }).days ?? 14);
    const analytics = await container.admin.analytics(days);
    return sendPrivate(request, reply, analytics);
  });
}
