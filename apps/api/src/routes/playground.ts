/**
 * Playground routes (report 32, FR-04, 20.2).
 *
 * The strictest rate limit on the platform applies here (10/min): every call
 * makes the server issue an outbound request, so this is the endpoint an
 * attacker would use to turn APIHub into an open proxy.
 */
import { CodeGenRequestSchema, PlaygroundRequestSchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';

import type { Container } from '../app/container.js';
import { ok } from '../app/envelope.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

export async function registerPlaygroundRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  app.post(
    '/playground/requests',
    {
      preHandler: rateLimit('playground'),
      // A separate, smaller body limit than the global one: a playground
      // request body is user content we forward, so it stays tightly bounded.
      bodyLimit: 128 * 1024,
    },
    async (request, reply) => {
      const input = PlaygroundRequestSchema.parse(request.body);

      const result = await container.playground.execute(input, {
        requestId: request.requestId,
        userId: request.user?.id ?? null,
      });

      // Responses may contain the user's own credentials echoed back by the
      // upstream, so they must never be stored by any cache.
      return reply.header('Cache-Control', 'no-store').send(ok(request, result));
    },
  );

  /** Generate an integration snippet for one language. */
  app.post('/playground/code', async (request, reply) => {
    const { language, request: playgroundRequest } = CodeGenRequestSchema.parse(request.body);
    const result = container.playground.generate(language, playgroundRequest);
    return reply.header('Cache-Control', 'no-store').send(ok(request, result));
  });

  /** Generate every language at once, for the detail page's code tabs. */
  app.post('/playground/code/all', async (request, reply) => {
    const input = PlaygroundRequestSchema.parse(request.body);
    const results = container.playground.generateAll(input);
    return reply.header('Cache-Control', 'no-store').send(ok(request, results));
  });
}
