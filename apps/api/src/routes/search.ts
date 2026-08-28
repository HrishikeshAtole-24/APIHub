/**
 * Search, suggest and recommendation routes (report 32, FR-02, FR-11).
 */
import { RecommendRequestSchema, SearchQuerySchema, SuggestQuerySchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';

import type { Container } from '../app/container.js';
import { ok, paginated, sendCacheable } from '../app/envelope.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

export async function registerSearchRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  app.get('/search', { preHandler: rateLimit('search') }, async (request, reply) => {
    const query = SearchQuerySchema.parse(request.query);
    const { result, pagination, cached } = await container.search.search(query);

    return reply.header('Cache-Control', 'public, max-age=30').send(
      paginated(request, result.hits, pagination, {
        cached,
        didYouMean: result.didYouMean,
        tookMs: result.tookMs,
        mode: result.mode,
      }),
    );
  });

  /**
   * Typeahead. Cached hard and kept cheap: it fires on nearly every keystroke,
   * so it must never touch the ranking pipeline.
   */
  app.get('/suggest', async (request, reply) => {
    const { q, limit } = SuggestQuerySchema.parse(request.query);
    const suggestions = await container.search.suggest(q, limit);
    return sendCacheable(request, reply, suggestions, 300);
  });

  /**
   * Recommendations from a natural-language project description.
   * Deterministic and grounded; see modules/recommendations/service.ts.
   */
  app.post('/recommend', { preHandler: rateLimit('search') }, async (request, reply) => {
    const input = RecommendRequestSchema.parse(request.body);
    const result = await container.recommendations.recommend(input);
    return reply.header('Cache-Control', 'no-store').send(ok(request, result));
  });
}
