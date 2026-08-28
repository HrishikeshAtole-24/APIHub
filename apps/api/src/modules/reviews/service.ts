/**
 * Reviews (report Feature 6, 20.1 XSS controls).
 *
 * Multi-dimensional ratings: an overall score plus optional sub-scores for
 * reliability, documentation, developer experience and free tier. The detail
 * page renders those as the bar chart in the report's mock-up.
 */
import type { CreateReview, Review, ReviewSummary } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { events, type CacheService } from '@apihub/runtime';
import { sanitizeUserText } from '@apihub/security';
import { and, avg, count, desc, eq, sql } from 'drizzle-orm';

import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors.js';

export class ReviewService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheService,
  ) {}

  async listForApi(
    apiId: string,
    viewerId: string | null,
    page: number,
    pageSize: number,
  ): Promise<{ items: Review[]; total: number }> {
    const where = and(
      eq(schema.reviews.apiId, apiId),
      eq(schema.reviews.moderationStatus, 'published'),
    );

    const [totalRow, rows] = await Promise.all([
      this.db.select({ value: count() }).from(schema.reviews).where(where),
      this.db
        .select({ review: schema.reviews, user: schema.users })
        .from(schema.reviews)
        .innerJoin(schema.users, eq(schema.users.id, schema.reviews.userId))
        .where(where)
        .orderBy(desc(schema.reviews.helpfulCount), desc(schema.reviews.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    return {
      items: rows.map(({ review, user }) => toReview(review, user, viewerId)),
      total: Number(totalRow[0]?.value ?? 0),
    };
  }

  /** Aggregate ratings, including the star distribution for the histogram. */
  async summaryForApi(apiId: string): Promise<ReviewSummary> {
    return this.cache.getOrSet(
      `reviews:summary:${apiId}`,
      async () => {
        const where = and(
          eq(schema.reviews.apiId, apiId),
          eq(schema.reviews.moderationStatus, 'published'),
        );

        const [row] = await this.db
          .select({
            average: avg(schema.reviews.ratingOverall),
            total: count(),
            // One pass with FILTER beats five separate COUNT queries.
            star1: sql<number>`count(*) FILTER (WHERE ${schema.reviews.ratingOverall} = 1)`,
            star2: sql<number>`count(*) FILTER (WHERE ${schema.reviews.ratingOverall} = 2)`,
            star3: sql<number>`count(*) FILTER (WHERE ${schema.reviews.ratingOverall} = 3)`,
            star4: sql<number>`count(*) FILTER (WHERE ${schema.reviews.ratingOverall} = 4)`,
            star5: sql<number>`count(*) FILTER (WHERE ${schema.reviews.ratingOverall} = 5)`,
            reliability: avg(schema.reviews.ratingReliability),
            documentation: avg(schema.reviews.ratingDocumentation),
            developerExperience: avg(schema.reviews.ratingDeveloperExperience),
            freeTier: avg(schema.reviews.ratingFreeTier),
          })
          .from(schema.reviews)
          .where(where);

        const toNumber = (value: unknown): number | null =>
          value === null || value === undefined ? null : Number(value);

        return {
          average: Number(row?.average ?? 0),
          count: Number(row?.total ?? 0),
          distribution: [
            Number(row?.star1 ?? 0),
            Number(row?.star2 ?? 0),
            Number(row?.star3 ?? 0),
            Number(row?.star4 ?? 0),
            Number(row?.star5 ?? 0),
          ],
          dimensions: {
            reliability: toNumber(row?.reliability),
            documentation: toNumber(row?.documentation),
            developerExperience: toNumber(row?.developerExperience),
            freeTier: toNumber(row?.freeTier),
          },
        };
      },
      { ttlSeconds: 300 },
    );
  }

  async create(apiId: string, userId: string, input: CreateReview): Promise<Review> {
    const [api] = await this.db
      .select({ id: schema.apis.id })
      .from(schema.apis)
      .where(eq(schema.apis.id, apiId))
      .limit(1);

    if (!api) throw new NotFoundError('API');

    const [existing] = await this.db
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(and(eq(schema.reviews.apiId, apiId), eq(schema.reviews.userId, userId)))
      .limit(1);

    if (existing) {
      throw new ConflictError('You have already reviewed this API. Edit your existing review.');
    }

    const [created] = await this.db
      .insert(schema.reviews)
      .values({
        id: schema.newId('review'),
        userId,
        apiId,
        ratingOverall: input.ratings.overall,
        ratingReliability: input.ratings.reliability ?? null,
        ratingDocumentation: input.ratings.documentation ?? null,
        ratingDeveloperExperience: input.ratings.developerExperience ?? null,
        ratingFreeTier: input.ratings.freeTier ?? null,
        // Sanitised on write: stored text is normalised and stripped of
        // invisible/bidi characters (report 20.1).
        title: input.title ? sanitizeUserText(input.title, 120) : null,
        body: input.body ? sanitizeUserText(input.body, 4000) : null,
      })
      .returning();

    if (!created) throw new Error('Failed to create review');

    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    await this.cache.invalidate(`reviews:summary:${apiId}`);
    events.emitAsync('review.created', {
      reviewId: created.id,
      apiId,
      userId,
      rating: input.ratings.overall,
    });

    return toReview(created, user!, userId);
  }

  async update(reviewId: string, userId: string, input: CreateReview): Promise<Review> {
    const existing = await this.requireOwn(reviewId, userId);

    const [updated] = await this.db
      .update(schema.reviews)
      .set({
        ratingOverall: input.ratings.overall,
        ratingReliability: input.ratings.reliability ?? null,
        ratingDocumentation: input.ratings.documentation ?? null,
        ratingDeveloperExperience: input.ratings.developerExperience ?? null,
        ratingFreeTier: input.ratings.freeTier ?? null,
        title: input.title ? sanitizeUserText(input.title, 120) : null,
        body: input.body ? sanitizeUserText(input.body, 4000) : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.reviews.id, reviewId))
      .returning();

    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    await this.cache.invalidate(`reviews:summary:${existing.apiId}`);
    return toReview(updated!, user!, userId);
  }

  async remove(reviewId: string, userId: string, isModerator: boolean): Promise<void> {
    const [row] = await this.db
      .select({ userId: schema.reviews.userId, apiId: schema.reviews.apiId })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .limit(1);

    if (!row) throw new NotFoundError('Review');
    if (row.userId !== userId && !isModerator) {
      throw new ForbiddenError('You can only delete your own reviews.');
    }

    await this.db.delete(schema.reviews).where(eq(schema.reviews.id, reviewId));
    await this.cache.invalidate(`reviews:summary:${row.apiId}`);
    events.emitAsync('review.deleted', { reviewId, apiId: row.apiId });
  }

  /**
   * Mark a review helpful.
   *
   * The vote table's composite primary key makes this idempotent at the
   * database level; the counter is only incremented when a row was actually
   * inserted, so a double-click cannot inflate it.
   */
  async vote(reviewId: string, userId: string): Promise<number> {
    const inserted = await this.db
      .insert(schema.reviewVotes)
      .values({ reviewId, userId })
      .onConflictDoNothing()
      .returning({ reviewId: schema.reviewVotes.reviewId });

    if (inserted.length === 0) {
      const [row] = await this.db
        .select({ helpfulCount: schema.reviews.helpfulCount })
        .from(schema.reviews)
        .where(eq(schema.reviews.id, reviewId))
        .limit(1);
      return row?.helpfulCount ?? 0;
    }

    const [updated] = await this.db
      .update(schema.reviews)
      .set({ helpfulCount: sql`${schema.reviews.helpfulCount} + 1` })
      .where(eq(schema.reviews.id, reviewId))
      .returning({ helpfulCount: schema.reviews.helpfulCount });

    return updated?.helpfulCount ?? 0;
  }

  private async requireOwn(
    reviewId: string,
    userId: string,
  ): Promise<typeof schema.reviews.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .limit(1);

    if (!row) throw new NotFoundError('Review');
    if (row.userId !== userId) throw new ForbiddenError('You can only edit your own reviews.');
    return row;
  }
}

function toReview(
  row: typeof schema.reviews.$inferSelect,
  user: typeof schema.users.$inferSelect,
  viewerId: string | null,
): Review {
  return {
    id: row.id,
    apiId: row.apiId,
    author: { id: user.id, name: user.name, avatarColor: user.avatarColor },
    ratings: {
      overall: row.ratingOverall,
      reliability: row.ratingReliability,
      documentation: row.ratingDocumentation,
      developerExperience: row.ratingDeveloperExperience,
      freeTier: row.ratingFreeTier,
    },
    title: row.title,
    body: row.body,
    helpfulCount: row.helpfulCount,
    isOwn: viewerId !== null && viewerId === row.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
