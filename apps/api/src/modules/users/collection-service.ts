/**
 * Collections (report FR-07).
 *
 * A collection is a user-curated group of APIs, e.g. "my ecommerce stack".
 * Public collections are readable by anyone with the link; private ones only
 * by their owner. That authorization check lives here, not in the routes, so
 * it cannot be forgotten on a new endpoint.
 */
import { slugify } from '@apihub/algorithms';
import type { Collection, CreateCollection, UpdateCollection } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { sanitizeUserText } from '@apihub/security';
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';

import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import type { CatalogRepository } from '../catalog/repository.js';

export class CollectionService {
  constructor(
    private readonly db: Database,
    private readonly catalog: CatalogRepository,
  ) {}

  async listForUser(userId: string): Promise<Collection[]> {
    const rows = await this.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.userId, userId))
      .orderBy(desc(schema.collections.updatedAt));

    return rows.map(toCollection);
  }

  async create(userId: string, input: CreateCollection): Promise<Collection> {
    const name = sanitizeUserText(input.name, 80);
    if (name.length === 0) throw new ConflictError('A collection needs a name.');

    const slug = await this.uniqueSlug(userId, slugify(name));

    const [created] = await this.db
      .insert(schema.collections)
      .values({
        id: schema.newId('collection'),
        userId,
        slug,
        name,
        description: input.description ? sanitizeUserText(input.description, 500) : null,
        isPublic: input.isPublic,
      })
      .returning();

    if (!created) throw new Error('Failed to create collection');
    return toCollection(created);
  }

  /**
   * Find a free slug for this user by appending a counter.
   *
   * Scoped per user (the schema's unique index is on user_id + slug), so two
   * people can both own a collection called "weather".
   */
  private async uniqueSlug(userId: string, base: string): Promise<string> {
    const existing = await this.db
      .select({ slug: schema.collections.slug })
      .from(schema.collections)
      .where(eq(schema.collections.userId, userId));

    const taken = new Set(existing.map((row) => row.slug));
    if (!taken.has(base)) return base;

    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /** Load a collection, enforcing visibility. */
  async get(id: string, viewerId: string | null): Promise<Collection> {
    const [row] = await this.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, id))
      .limit(1);

    if (!row) throw new NotFoundError('Collection');
    if (!row.isPublic && row.userId !== viewerId) {
      // 404 rather than 403: revealing that a private collection exists is
      // itself a small information leak.
      throw new NotFoundError('Collection');
    }

    const items = await this.db
      .select({ apiId: schema.collectionItems.apiId })
      .from(schema.collectionItems)
      .where(eq(schema.collectionItems.collectionId, id))
      .orderBy(asc(schema.collectionItems.position));

    const apis = await this.catalog.findManyByIds(items.map((item) => item.apiId));
    return { ...toCollection(row), items: apis };
  }

  async update(id: string, userId: string, input: UpdateCollection): Promise<Collection> {
    await this.assertOwner(id, userId);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch['name'] = sanitizeUserText(input.name, 80);
    if (input.description !== undefined) {
      patch['description'] = input.description ? sanitizeUserText(input.description, 500) : null;
    }
    if (input.isPublic !== undefined) patch['isPublic'] = input.isPublic;

    const [updated] = await this.db
      .update(schema.collections)
      .set(patch)
      .where(eq(schema.collections.id, id))
      .returning();

    if (!updated) throw new NotFoundError('Collection');
    return toCollection(updated);
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.assertOwner(id, userId);
    await this.db.delete(schema.collections).where(eq(schema.collections.id, id));
  }

  async addItem(collectionId: string, userId: string, apiId: string, note?: string): Promise<void> {
    await this.assertOwner(collectionId, userId);

    const [nextPosition] = await this.db
      .select({ value: max(schema.collectionItems.position) })
      .from(schema.collectionItems)
      .where(eq(schema.collectionItems.collectionId, collectionId));

    await this.db
      .insert(schema.collectionItems)
      .values({
        collectionId,
        apiId,
        position: (nextPosition?.value ?? -1) + 1,
        note: note ? sanitizeUserText(note, 500) : null,
      })
      .onConflictDoNothing();

    await this.refreshCount(collectionId);
  }

  async removeItem(collectionId: string, userId: string, apiId: string): Promise<void> {
    await this.assertOwner(collectionId, userId);

    await this.db
      .delete(schema.collectionItems)
      .where(
        and(
          eq(schema.collectionItems.collectionId, collectionId),
          eq(schema.collectionItems.apiId, apiId),
        ),
      );

    await this.refreshCount(collectionId);
  }

  /** Keep the denormalised item count in step with reality. */
  private async refreshCount(collectionId: string): Promise<void> {
    await this.db
      .update(schema.collections)
      .set({
        itemCount: sql`(SELECT count(*) FROM ${schema.collectionItems} WHERE collection_id = ${collectionId})`,
        updatedAt: new Date(),
      })
      .where(eq(schema.collections.id, collectionId));
  }

  private async assertOwner(id: string, userId: string): Promise<void> {
    const [row] = await this.db
      .select({ userId: schema.collections.userId })
      .from(schema.collections)
      .where(eq(schema.collections.id, id))
      .limit(1);

    if (!row) throw new NotFoundError('Collection');
    if (row.userId !== userId) throw new ForbiddenError('This collection belongs to someone else.');
  }
}

function toCollection(row: typeof schema.collections.$inferSelect): Collection {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    isPublic: row.isPublic,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
