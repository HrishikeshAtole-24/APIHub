/**
 * Favorites (report FR-06).
 */
import type { ApiSummary } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { events } from '@apihub/runtime';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { ApiNotFoundError } from '../../shared/errors.js';
import type { CatalogRepository } from '../catalog/repository.js';

export class FavoriteService {
  constructor(
    private readonly db: Database,
    private readonly catalog: CatalogRepository,
  ) {}

  async list(userId: string): Promise<ApiSummary[]> {
    const rows = await this.db
      .select({ apiId: schema.favorites.apiId })
      .from(schema.favorites)
      .where(eq(schema.favorites.userId, userId))
      .orderBy(desc(schema.favorites.createdAt));

    return this.catalog.findManyByIds(rows.map((row) => row.apiId));
  }

  /**
   * Add a favorite.
   *
   * `onConflictDoNothing` makes this idempotent: double-clicking the heart, or
   * a retried request, must not error.
   */
  async add(userId: string, apiId: string): Promise<void> {
    const [api] = await this.db
      .select({ id: schema.apis.id, slug: schema.apis.slug })
      .from(schema.apis)
      .where(eq(schema.apis.id, apiId))
      .limit(1);

    if (!api) throw new ApiNotFoundError(apiId);

    await this.db
      .insert(schema.favorites)
      .values({ userId, apiId })
      .onConflictDoNothing();

    events.emitAsync('favorite.added', { userId, apiId });
  }

  async remove(userId: string, apiId: string): Promise<void> {
    await this.db
      .delete(schema.favorites)
      .where(and(eq(schema.favorites.userId, userId), eq(schema.favorites.apiId, apiId)));

    events.emitAsync('favorite.removed', { userId, apiId });
  }

  /**
   * Which of these APIs the user has favorited.
   *
   * Batched so a list page can mark every card in one query rather than one
   * per card (report 33.1).
   */
  async whichAreFavorited(userId: string, apiIds: string[]): Promise<Set<string>> {
    if (apiIds.length === 0) return new Set();

    const rows = await this.db
      .select({ apiId: schema.favorites.apiId })
      .from(schema.favorites)
      .where(and(eq(schema.favorites.userId, userId), inArray(schema.favorites.apiId, apiIds)));

    return new Set(rows.map((row) => row.apiId));
  }

  async isFavorited(userId: string, apiId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ apiId: schema.favorites.apiId })
      .from(schema.favorites)
      .where(and(eq(schema.favorites.userId, userId), eq(schema.favorites.apiId, apiId)))
      .limit(1);

    return Boolean(row);
  }
}
