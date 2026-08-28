/**
 * Review routes (report Feature 6, 32).
 */
import { CreateReviewSchema, IdSchema, PaginationQuerySchema, SlugSchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Container } from '../app/container.js';
import { ok, paginated, sendPrivate } from '../app/envelope.js';
import { requireAuth, requireCsrf } from '../app/plugins/auth.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

const SlugParams = z.object({ slug: SlugSchema });
const ReviewParams = z.object({ id: IdSchema });

export async function registerReviewRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const writeGuard = { preHandler: [requireAuth, requireCsrf, rateLimit('write')] };

  app.get('/apis/:slug/reviews', async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const { page, pageSize } = PaginationQuerySchema.parse(request.query);

    const api = await container.catalog.getBySlug(slug);
    const [{ items, total }, summary] = await Promise.all([
      container.reviews.listForApi(api.id, request.user?.id ?? null, page, pageSize),
      container.reviews.summaryForApi(api.id),
    ]);

    return reply.header('Cache-Control', 'no-store').send(
      paginated(
        request,
        items,
        {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
          hasNext: page * pageSize < total,
          hasPrevious: page > 1,
        },
        { summary },
      ),
    );
  });

  app.post('/apis/:slug/reviews', writeGuard, async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const input = CreateReviewSchema.parse(request.body);

    const api = await container.catalog.getBySlug(slug);
    const review = await container.reviews.create(api.id, request.user!.id, input);

    return reply.status(201).send(ok(request, review));
  });

  app.patch('/reviews/:id', writeGuard, async (request, reply) => {
    const { id } = ReviewParams.parse(request.params);
    const input = CreateReviewSchema.parse(request.body);
    const review = await container.reviews.update(id, request.user!.id, input);
    return sendPrivate(request, reply, review);
  });

  app.delete('/reviews/:id', writeGuard, async (request, reply) => {
    const { id } = ReviewParams.parse(request.params);
    const isModerator = request.user!.role === 'moderator' || request.user!.role === 'admin';
    await container.reviews.remove(id, request.user!.id, isModerator);
    return sendPrivate(request, reply, { deleted: true });
  });

  app.post('/reviews/:id/helpful', writeGuard, async (request, reply) => {
    const { id } = ReviewParams.parse(request.params);
    const helpfulCount = await container.reviews.vote(id, request.user!.id);
    return sendPrivate(request, reply, { helpfulCount });
  });
}
