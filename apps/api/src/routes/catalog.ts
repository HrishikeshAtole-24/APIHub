/**
 * Catalogue routes (report 32).
 *
 *   GET /v1/apis              browse and filter
 *   GET /v1/apis/:slug        API detail
 *   GET /v1/apis/:slug/related
 *   GET /v1/categories
 *   GET /v1/categories/:slug
 *   GET /v1/compare?slugs=a,b
 *   GET /v1/stats
 */
import { ApiListQuerySchema, CompareQuerySchema, SlugSchema } from '@apihub/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Container } from '../app/container.js';
import { ok, paginated, sendCacheable } from '../app/envelope.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

const SlugParams = z.object({ slug: SlugSchema });

export async function registerCatalogRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /**
   * Browse the catalogue.
   *
   * Facets are computed only when asked for: the sidebar needs them, but an
   * infinite-scroll "next page" fetch does not, and they cost an extra query.
   */
  app.get('/apis', async (request, reply) => {
    const query = ApiListQuerySchema.parse(request.query);
    const wantsFacets = (request.query as { facets?: string }).facets === 'true';

    const [result, facets] = await Promise.all([
      container.catalog.list(query),
      wantsFacets ? container.catalog.facets(query) : Promise.resolve(undefined),
    ]);

    // Personalise: mark which results the signed-in user has favorited.
    let favorited: string[] = [];
    if (request.user) {
      const set = await container.favorites.whichAreFavorited(
        request.user.id,
        result.items.map((item) => item.id),
      );
      favorited = [...set];
    }

    return reply
      .header('Cache-Control', request.user ? 'private, no-store' : 'public, max-age=60')
      .send(
        paginated(request, result.items, result.pagination, {
          cached: result.cached,
          facets,
          favorited,
        }),
      );
  });

  app.get('/apis/:slug', async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const detail = await container.catalog.getBySlug(slug);

    const isFavorited = request.user
      ? await container.favorites.isFavorited(request.user.id, detail.id)
      : false;

    const reviewSummary = await container.reviews.summaryForApi(detail.id);

    if (request.user) {
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(ok(request, detail, { isFavorited, reviewSummary }));
    }

    return sendCacheable(request, reply, detail, 300, { isFavorited, reviewSummary });
  });

  app.get('/apis/:slug/related', async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const detail = await container.catalog.getBySlug(slug);
    const related = await container.search.related(detail.id, 6);
    return sendCacheable(request, reply, related, 600);
  });

  app.get('/categories', async (request, reply) => {
    const categories = await container.catalog.categories();
    return sendCacheable(request, reply, categories, 900);
  });

  app.get('/categories/:slug', async (request, reply) => {
    const { slug } = SlugParams.parse(request.params);
    const category = await container.catalog.categoryBySlug(slug);
    return sendCacheable(request, reply, category, 900);
  });

  /** Side-by-side comparison of 2-4 APIs (report FR-05). */
  app.get('/compare', { preHandler: rateLimit('search') }, async (request, reply) => {
    const { slugs } = CompareQuerySchema.parse(request.query);
    const result = await container.recommendations.compare(slugs);
    return sendCacheable(request, reply, result, 300);
  });

  app.get('/stats', async (request, reply) => {
    const stats = await container.catalog.stats();
    return sendCacheable(request, reply, stats, 300);
  });
}
