/**
 * Authenticated user routes: favorites and collections (report 32, FR-06/07).
 *
 * Every route here requires a session and CSRF on writes.
 */
import { CreateCollectionSchema, IdSchema, UpdateCollectionSchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Container } from '../app/container.js';
import { sendPrivate } from '../app/envelope.js';
import { requireAuth, requireCsrf } from '../app/plugins/auth.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

const ApiIdParams = z.object({ apiId: IdSchema });
const CollectionParams = z.object({ id: IdSchema });
const CollectionItemParams = z.object({ id: IdSchema, apiId: IdSchema });

export async function registerMeRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const authed = { preHandler: [requireAuth] };
  const writeGuard = { preHandler: [requireAuth, requireCsrf, rateLimit('write')] };

  // ── Favorites ─────────────────────────────────────────────
  app.get('/me/favorites', authed, async (request, reply) => {
    const favorites = await container.favorites.list(request.user!.id);
    return sendPrivate(request, reply, favorites);
  });

  app.post('/me/favorites/:apiId', writeGuard, async (request, reply) => {
    const { apiId } = ApiIdParams.parse(request.params);
    await container.favorites.add(request.user!.id, apiId);
    return sendPrivate(request, reply, { apiId, favorited: true });
  });

  app.delete('/me/favorites/:apiId', writeGuard, async (request, reply) => {
    const { apiId } = ApiIdParams.parse(request.params);
    await container.favorites.remove(request.user!.id, apiId);
    return sendPrivate(request, reply, { apiId, favorited: false });
  });

  // ── Collections ───────────────────────────────────────────
  app.get('/me/collections', authed, async (request, reply) => {
    const collections = await container.collections.listForUser(request.user!.id);
    return sendPrivate(request, reply, collections);
  });

  app.post('/me/collections', writeGuard, async (request, reply) => {
    const input = CreateCollectionSchema.parse(request.body);
    const collection = await container.collections.create(request.user!.id, input);
    return reply.status(201).send({ data: collection, meta: { requestId: request.requestId } });
  });

  app.patch('/me/collections/:id', writeGuard, async (request, reply) => {
    const { id } = CollectionParams.parse(request.params);
    const input = UpdateCollectionSchema.parse(request.body);
    const collection = await container.collections.update(id, request.user!.id, input);
    return sendPrivate(request, reply, collection);
  });

  app.delete('/me/collections/:id', writeGuard, async (request, reply) => {
    const { id } = CollectionParams.parse(request.params);
    await container.collections.remove(id, request.user!.id);
    return sendPrivate(request, reply, { deleted: true });
  });

  app.post('/me/collections/:id/items/:apiId', writeGuard, async (request, reply) => {
    const { id, apiId } = CollectionItemParams.parse(request.params);
    const body = z.object({ note: z.string().max(500).optional() }).parse(request.body ?? {});
    await container.collections.addItem(id, request.user!.id, apiId, body.note);
    return sendPrivate(request, reply, { added: true });
  });

  app.delete('/me/collections/:id/items/:apiId', writeGuard, async (request, reply) => {
    const { id, apiId } = CollectionItemParams.parse(request.params);
    await container.collections.removeItem(id, request.user!.id, apiId);
    return sendPrivate(request, reply, { removed: true });
  });

  /**
   * Public collection view. Not under /me because a public collection is
   * readable without a session; the service enforces visibility.
   */
  app.get('/collections/:id', async (request, reply) => {
    const { id } = CollectionParams.parse(request.params);
    const collection = await container.collections.get(id, request.user?.id ?? null);
    return sendPrivate(request, reply, collection);
  });
}
