/**
 * Catalogue repository (Repository pattern, report 22, 11.1).
 *
 * The report warns against "generic repository layers that hide useful SQL",
 * so this is a concrete, purpose-built repository: it exposes the queries the
 * catalogue actually needs and writes real SQL where real SQL is the right
 * tool.
 *
 * N+1 avoidance (report 33.1) is structural here: list queries fetch the page
 * of APIs, then batch-load categories, ratings and favorite counts for the
 * whole page in one query each. Three queries per page, regardless of size.
 */
import type { ApiDetail, ApiListQuery, ApiSummary, Category, PlatformStats } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { toApiDetail, toApiSummary, type ApiAggregates, type ApiRowWithHealth } from './mappers.js';
import { all, specificationsFor } from './specifications.js';

const { apis, apiHealthLatest, apiCategories, categories, reviews, favorites } = schema;

export interface ListResult {
  items: ApiSummary[];
  total: number;
}

export class CatalogRepository {
  constructor(private readonly db: Database) {}

  /** Columns shared by list and detail reads. Never `SELECT *` (report 33.1). */
  private get summaryColumns() {
    return {
      id: apis.id,
      slug: apis.slug,
      name: apis.name,
      provider: apis.provider,
      description: apis.description,
      docsUrl: apis.docsUrl,
      baseUrl: apis.baseUrl,
      authType: apis.authType,
      httpsSupported: apis.httpsSupported,
      corsStatus: apis.corsStatus,
      isFree: apis.isFree,
      hasFreeTier: apis.hasFreeTier,
      status: apis.status,
      popularityScore: apis.popularityScore,
      tags: apis.tags,
      updatedAt: apis.updatedAt,
      createdAt: apis.createdAt,
      healthStatus: apiHealthLatest.status,
      healthLatency: apiHealthLatest.latencyMs,
      healthUptime30d: apiHealthLatest.uptime30d,
      healthReliability: apiHealthLatest.reliabilityScore,
      healthCheckedAt: apiHealthLatest.lastCheckedAt,
      healthFailures: apiHealthLatest.consecutiveFailures,
    };
  }

  private orderBy(sort: ApiListQuery['sort']): SQL[] {
    switch (sort) {
      case 'name':
        return [asc(apis.name)];
      case 'newest':
        return [desc(apis.createdAt)];
      case 'reliability':
        // NULLS LAST keeps never-probed APIs from occupying the top slots.
        return [sql`${apiHealthLatest.reliabilityScore} DESC NULLS LAST`, desc(apis.popularityScore)];
      case 'rating':
        return [desc(apis.popularityScore)];
      case 'popularity':
      case 'relevance':
      default:
        return [desc(apis.popularityScore), asc(apis.name)];
    }
  }

  async list(query: ApiListQuery): Promise<ListResult> {
    const where = all(...specificationsFor(query));
    const offset = (query.page - 1) * query.pageSize;

    // Count and page fetched in parallel: they are independent reads.
    const [totalRows, rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(apis)
        .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
        .where(where),
      this.db
        .select(this.summaryColumns)
        .from(apis)
        .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
        .where(where)
        .orderBy(...this.orderBy(query.sort))
        .limit(query.pageSize)
        .offset(offset),
    ]);

    const total = totalRows[0]?.value ?? 0;
    const items = await this.hydrate(rows as ApiRowWithHealth[]);
    return { items, total };
  }

  /** Attach categories and aggregates to a page of rows. Batched, never per row. */
  private async hydrate(rows: ApiRowWithHealth[]): Promise<ApiSummary[]> {
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const [categoryRows, ratingRows, favoriteRows] = await Promise.all([
      this.db
        .select({
          apiId: apiCategories.apiId,
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
        })
        .from(apiCategories)
        .innerJoin(categories, eq(categories.id, apiCategories.categoryId))
        .where(inArray(apiCategories.apiId, ids)),

      this.db
        .select({
          apiId: reviews.apiId,
          average: sql<number>`avg(${reviews.ratingOverall})`,
          total: count(),
        })
        .from(reviews)
        .where(and(inArray(reviews.apiId, ids), eq(reviews.moderationStatus, 'published')))
        .groupBy(reviews.apiId),

      this.db
        .select({ apiId: favorites.apiId, total: count() })
        .from(favorites)
        .where(inArray(favorites.apiId, ids))
        .groupBy(favorites.apiId),
    ]);

    const categoryMap = new Map<string, { id: string; slug: string; name: string }[]>();
    for (const row of categoryRows) {
      const bucket = categoryMap.get(row.apiId) ?? [];
      bucket.push({ id: row.id, slug: row.slug, name: row.name });
      categoryMap.set(row.apiId, bucket);
    }

    const aggregates = new Map<string, ApiAggregates>();
    for (const row of ratingRows) {
      aggregates.set(row.apiId, {
        averageRating: row.average === null ? null : Number(row.average),
        reviewCount: Number(row.total),
        favoriteCount: 0,
      });
    }
    for (const row of favoriteRows) {
      const existing = aggregates.get(row.apiId) ?? {
        averageRating: null,
        reviewCount: 0,
        favoriteCount: 0,
      };
      existing.favoriteCount = Number(row.total);
      aggregates.set(row.apiId, existing);
    }

    return rows.map((row) =>
      toApiSummary(row, categoryMap.get(row.id) ?? [], aggregates.get(row.id)),
    );
  }

  /** Batch-hydrate a set of ids, preserving the caller's ordering. */
  async findManyByIds(ids: string[]): Promise<ApiSummary[]> {
    if (ids.length === 0) return [];

    const rows = await this.db
      .select(this.summaryColumns)
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(inArray(apis.id, ids));

    const hydrated = await this.hydrate(rows as ApiRowWithHealth[]);
    const byId = new Map(hydrated.map((item) => [item.id, item]));

    return ids.map((id) => byId.get(id)).filter((item): item is ApiSummary => item !== undefined);
  }

  async findManyBySlugs(slugs: string[]): Promise<ApiSummary[]> {
    if (slugs.length === 0) return [];

    const rows = await this.db
      .select(this.summaryColumns)
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(inArray(apis.slug, slugs));

    const hydrated = await this.hydrate(rows as ApiRowWithHealth[]);
    const bySlug = new Map(hydrated.map((item) => [item.slug, item]));

    return slugs.map((slug) => bySlug.get(slug)).filter((i): i is ApiSummary => i !== undefined);
  }

  async findBySlug(slug: string): Promise<ApiDetail | null> {
    const [row] = await this.db
      .select({
        ...this.summaryColumns,
        longDescription: apis.longDescription,
        rateLimit: apis.rateLimit,
        sourceRevision: apis.sourceRevision,
        importedAt: apis.importedAt,
        sourceName: schema.apiSources.name,
        sourceUrl: schema.apiSources.url,
        sourceLicense: schema.apiSources.license,
        transformVersion: schema.apiSources.transformVersion,
      })
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .leftJoin(schema.apiSources, eq(schema.apiSources.id, apis.sourceId))
      .where(eq(apis.slug, slug))
      .limit(1);

    if (!row) return null;

    const [summary] = await this.hydrate([row as ApiRowWithHealth]);
    if (!summary) return null;

    const [endpoints, authSchemes] = await Promise.all([
      this.db
        .select()
        .from(schema.apiEndpoints)
        .where(eq(schema.apiEndpoints.apiId, row.id))
        .orderBy(asc(schema.apiEndpoints.position)),
      this.db.select().from(schema.apiAuthSchemes).where(eq(schema.apiAuthSchemes.apiId, row.id)),
    ]);

    const alternatives = await this.findAlternatives(row.id, 4);

    return toApiDetail(summary, row, endpoints, authSchemes, alternatives);
  }

  /**
   * "Alternatives" panel: other APIs sharing a category, best first.
   *
   * Content similarity would be better, and the recommendation service does
   * exactly that when embeddings are available. This is the always-available
   * baseline (report 26.1: AI is an augmentation, never a dependency).
   */
  async findAlternatives(
    apiId: string,
    limit: number,
  ): Promise<{ id: string; slug: string; name: string; description: string }[]> {
    return this.db
      .select({
        id: apis.id,
        slug: apis.slug,
        name: apis.name,
        description: apis.description,
      })
      .from(apis)
      .where(
        and(
          eq(apis.status, 'active'),
          sql`${apis.id} <> ${apiId}`,
          sql`EXISTS (
            SELECT 1
              FROM ${apiCategories} a
              JOIN ${apiCategories} b ON a.category_id = b.category_id
             WHERE a.api_id = ${apis.id} AND b.api_id = ${apiId}
          )`,
        ),
      )
      .orderBy(desc(apis.popularityScore))
      .limit(limit);
  }

  async listCategories(): Promise<Category[]> {
    const rows = await this.db
      .select({
        id: categories.id,
        slug: categories.slug,
        name: categories.name,
        description: categories.description,
        icon: categories.icon,
        apiCount: categories.apiCount,
      })
      .from(categories)
      .where(sql`${categories.apiCount} > 0`)
      .orderBy(desc(categories.apiCount), asc(categories.name));

    return rows.map((row) => ({ ...row, apiCount: Number(row.apiCount) }));
  }

  async findCategoryBySlug(slug: string): Promise<Category | null> {
    const [row] = await this.db
      .select({
        id: categories.id,
        slug: categories.slug,
        name: categories.name,
        description: categories.description,
        icon: categories.icon,
        apiCount: categories.apiCount,
      })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1);

    return row ? { ...row, apiCount: Number(row.apiCount) } : null;
  }

  /**
   * Facet counts for the filter sidebar.
   *
   * Computed with FILTER aggregates in a single pass rather than one COUNT per
   * facet, so the whole sidebar costs one query.
   */
  async facets(query: ApiListQuery): Promise<{
    auth: { value: string; count: number }[];
    health: { value: string; count: number }[];
    features: { value: string; count: number }[];
  }> {
    // Facet counts intentionally ignore the facet being counted, so a user can
    // see what selecting a different value would yield.
    const base = all(...specificationsFor({ ...query, auth: undefined, status: undefined }));

    const [featureRow] = await this.db
      .select({
        free: sql<number>`count(*) FILTER (WHERE ${apis.isFree})`,
        https: sql<number>`count(*) FILTER (WHERE ${apis.httpsSupported})`,
        cors: sql<number>`count(*) FILTER (WHERE ${apis.corsStatus} = 'yes')`,
      })
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(base);

    const authRows = await this.db
      .select({ value: apis.authType, total: count() })
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(base)
      .groupBy(apis.authType)
      .orderBy(desc(count()));

    const healthRows = await this.db
      .select({
        value: sql<string>`coalesce(${apiHealthLatest.status}, 'unknown')`,
        total: count(),
      })
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(base)
      .groupBy(sql`coalesce(${apiHealthLatest.status}, 'unknown')`);

    return {
      auth: authRows.map((row) => ({ value: row.value, count: Number(row.total) })),
      health: healthRows.map((row) => ({ value: row.value, count: Number(row.total) })),
      features: [
        { value: 'free', count: Number(featureRow?.free ?? 0) },
        { value: 'https', count: Number(featureRow?.https ?? 0) },
        { value: 'cors', count: Number(featureRow?.cors ?? 0) },
      ],
    };
  }

  /** Landing-page and admin statistics. */
  async platformStats(): Promise<PlatformStats> {
    const [row] = await this.db
      .select({
        totalApis: count(),
        freeApis: sql<number>`count(*) FILTER (WHERE ${apis.isFree})`,
        noAuthApis: sql<number>`count(*) FILTER (WHERE ${apis.authType} = 'none')`,
        httpsApis: sql<number>`count(*) FILTER (WHERE ${apis.httpsSupported})`,
      })
      .from(apis)
      .where(eq(apis.status, 'active'));

    const [healthRow] = await this.db
      .select({
        monitored: count(),
        healthy: sql<number>`count(*) FILTER (WHERE ${apiHealthLatest.status} = 'up')`,
        avgLatency: sql<number | null>`avg(${apiHealthLatest.latencyMs})`,
      })
      .from(apiHealthLatest);

    const [categoryRow] = await this.db.select({ value: count() }).from(categories);

    const [ingestionRow] = await this.db
      .select({ finishedAt: schema.ingestionRuns.finishedAt })
      .from(schema.ingestionRuns)
      .where(eq(schema.ingestionRuns.status, 'succeeded'))
      .orderBy(desc(schema.ingestionRuns.finishedAt))
      .limit(1);

    return {
      totalApis: Number(row?.totalApis ?? 0),
      totalCategories: Number(categoryRow?.value ?? 0),
      freeApis: Number(row?.freeApis ?? 0),
      noAuthApis: Number(row?.noAuthApis ?? 0),
      httpsApis: Number(row?.httpsApis ?? 0),
      monitoredApis: Number(healthRow?.monitored ?? 0),
      healthyApis: Number(healthRow?.healthy ?? 0),
      averageLatencyMs:
        healthRow?.avgLatency === null || healthRow?.avgLatency === undefined
          ? null
          : Math.round(Number(healthRow.avgLatency)),
      lastIngestionAt: ingestionRow?.finishedAt?.toISOString() ?? null,
    };
  }

  /** Increment the daily view counter (report FR-12). Fire-and-forget. */
  async recordView(apiId: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.db
      .insert(schema.apiViews)
      .values({ day, apiId, views: 1 })
      .onConflictDoUpdate({
        target: [schema.apiViews.day, schema.apiViews.apiId],
        set: { views: sql`${schema.apiViews.views} + 1` },
      });
  }
}
