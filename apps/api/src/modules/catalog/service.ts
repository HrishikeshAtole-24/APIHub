/**
 * Catalogue application service (report 11.1).
 *
 * Sits between the HTTP layer and the repository, and owns the things that are
 * neither transport nor persistence: caching policy, cache invalidation, and
 * reacting to domain events.
 */
import { createHash } from 'node:crypto';

import { CACHE_KEYS, CACHE_TTL } from '@apihub/config';
import type {
  ApiDetail,
  ApiFacets,
  ApiListQuery,
  ApiSummary,
  Category,
  PaginationMeta,
  PlatformStats,
} from '@apihub/contracts';
import { AUTH_TYPE_LABELS, HEALTH_STATUS_LABELS, buildPaginationMeta } from '@apihub/contracts';
import { events, type CacheService } from '@apihub/runtime';

import { ApiNotFoundError } from '../../shared/errors.js';
import type { CatalogRepository } from './repository.js';

/** Stable cache key for a query object: same filters must hash identically. */
export function hashQuery(query: Record<string, unknown>): string {
  const normalised = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? [...value].sort().join('|') : String(value)}`)
    .join('&');

  return createHash('sha1').update(normalised).digest('hex').slice(0, 16);
}

export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly cache: CacheService,
  ) {
    this.subscribeToEvents();
  }

  /**
   * Invalidate derived caches when the catalogue changes (Observer, report 22:
   * "APIUpdated -> invalidate cache").
   *
   * The service does not need to know who changes an API — ingestion, an admin
   * edit or a health probe — only that something did.
   */
  private subscribeToEvents(): void {
    const invalidateApi = async (slug: string) => {
      await this.cache.invalidate(
        CACHE_KEYS.apiDetail(slug),
        'api:list:*',
        'search:*',
        CACHE_KEYS.stats(),
      );
    };

    events.on('api.updated', ({ slug }) => invalidateApi(slug), 'catalog-cache');
    events.on('api.created', ({ slug }) => invalidateApi(slug), 'catalog-cache');
    events.on('api.deleted', ({ slug }) => invalidateApi(slug), 'catalog-cache');
    events.on('api.status_changed', ({ slug }) => invalidateApi(slug), 'catalog-cache');

    events.on(
      'ingestion.completed',
      async () => {
        // A completed import can touch anything; drop all derived catalogue caches.
        await this.cache.invalidate('api:*', 'search:*', CACHE_KEYS.categories(), CACHE_KEYS.stats());
      },
      'catalog-cache',
    );

    // Review changes alter the aggregate shown on cards and detail pages.
    events.on(
      'review.created',
      async ({ apiId }) => {
        await this.cache.invalidate(`api:detail:*`, 'api:list:*');
        void apiId;
      },
      'catalog-cache',
    );
  }

  async list(
    query: ApiListQuery,
  ): Promise<{ items: ApiSummary[]; pagination: PaginationMeta; cached: boolean }> {
    const key = CACHE_KEYS.apiList(hashQuery(query as unknown as Record<string, unknown>));
    let cached = true;

    const result = await this.cache.getOrSet(
      key,
      async () => {
        cached = false;
        return this.repository.list(query);
      },
      { ttlSeconds: CACHE_TTL.apiList },
    );

    return {
      items: result.items,
      pagination: buildPaginationMeta(query.page, query.pageSize, result.total),
      cached,
    };
  }

  async getBySlug(slug: string): Promise<ApiDetail> {
    const detail = await this.cache.getOrSet(
      CACHE_KEYS.apiDetail(slug),
      () => this.repository.findBySlug(slug),
      { ttlSeconds: CACHE_TTL.apiDetail },
    );

    if (!detail) throw new ApiNotFoundError(slug);

    // Analytics must never block or fail the read path.
    void this.repository.recordView(detail.id).catch(() => {});

    return detail;
  }

  async categories(): Promise<Category[]> {
    return this.cache.getOrSet(CACHE_KEYS.categories(), () => this.repository.listCategories(), {
      ttlSeconds: CACHE_TTL.categories,
    });
  }

  async categoryBySlug(slug: string): Promise<Category> {
    const category = await this.repository.findCategoryBySlug(slug);
    if (!category) throw new ApiNotFoundError(slug);
    return category;
  }

  /** Facet counts, decorated with display labels for the filter sidebar. */
  async facets(query: ApiListQuery): Promise<ApiFacets> {
    const key = `api:facets:${hashQuery(query as unknown as Record<string, unknown>)}`;

    const [raw, categories] = await Promise.all([
      this.cache.getOrSet(key, () => this.repository.facets(query), {
        ttlSeconds: CACHE_TTL.apiList,
      }),
      this.categories(),
    ]);

    const featureLabels: Record<string, string> = {
      free: 'Free to use',
      https: 'HTTPS',
      cors: 'CORS enabled',
    };

    return {
      categories: categories.map((category) => ({
        value: category.slug,
        label: category.name,
        count: category.apiCount,
      })),
      auth: raw.auth.map((bucket) => ({
        value: bucket.value,
        label: AUTH_TYPE_LABELS[bucket.value as keyof typeof AUTH_TYPE_LABELS] ?? bucket.value,
        count: bucket.count,
      })),
      health: raw.health.map((bucket) => ({
        value: bucket.value,
        label:
          HEALTH_STATUS_LABELS[bucket.value as keyof typeof HEALTH_STATUS_LABELS] ?? bucket.value,
        count: bucket.count,
      })),
      features: raw.features.map((bucket) => ({
        value: bucket.value,
        label: featureLabels[bucket.value] ?? bucket.value,
        count: bucket.count,
      })),
    };
  }

  async stats(): Promise<PlatformStats> {
    return this.cache.getOrSet(CACHE_KEYS.stats(), () => this.repository.platformStats(), {
      ttlSeconds: CACHE_TTL.stats,
    });
  }

  async compareBySlugs(slugs: string[]): Promise<ApiSummary[]> {
    const found = await this.repository.findManyBySlugs(slugs);
    if (found.length === 0) throw new ApiNotFoundError(slugs.join(', '));
    return found;
  }
}
