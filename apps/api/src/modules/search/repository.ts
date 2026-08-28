/**
 * Search repository (report 15.1).
 *
 * Retrieval only. It returns a BOUNDED candidate set with the raw signals the
 * ranker needs; it does not decide ordering. That separation is report 21.2:
 * "First retrieve a bounded candidate set using indexed search; then run
 * expensive ranking."
 */
import { schema, type Database } from '@apihub/database';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import { all, specificationsFor, textSearchSpecification } from '../catalog/specifications.js';
import type { RankingCandidate } from './ranking.js';

const { apis, apiHealthLatest, apiEndpoints } = schema;

/** How many candidates to retrieve before ranking. */
export const CANDIDATE_LIMIT = 400;

export interface CandidateFilters {
  free?: boolean;
  https?: boolean;
  cors?: boolean;
  auth?: string;
  category?: string;
  status?: string;
  tags?: string[];
}

export class SearchRepository {
  constructor(private readonly db: Database) {}

  /** Signals every candidate carries into the ranker. */
  private candidateColumns(rankExpression: SQL<number>) {
    return {
      id: apis.id,
      textRank: rankExpression,
      popularityScore: apis.popularityScore,
      reliabilityScore: apiHealthLatest.reliabilityScore,
      latencyMs: apiHealthLatest.latencyMs,
      updatedAt: apis.updatedAt,
      isFree: apis.isFree,
      hasFreeTier: apis.hasFreeTier,
      httpsSupported: apis.httpsSupported,
      docsUrl: apis.docsUrl,
      name: apis.name,
      description: apis.description,
      hasEndpoints: sql<boolean>`EXISTS (SELECT 1 FROM ${apiEndpoints} e WHERE e.api_id = ${apis.id})`,
    };
  }

  /**
   * Full-text candidate retrieval.
   *
   * `ts_rank_cd` is used rather than `ts_rank`: it accounts for term proximity,
   * so "weather forecast" ranks a document containing the phrase above one
   * that mentions each word in unrelated paragraphs.
   */
  async findCandidates(
    tsquery: string,
    filters: CandidateFilters,
    limit = CANDIDATE_LIMIT,
  ): Promise<(RankingCandidate & { name: string; description: string })[]> {
    const rankExpression = sql<number>`ts_rank_cd(${apis.searchVector}, to_tsquery('english', ${tsquery}))`;

    const where = all(
      ...specificationsFor(filters as never),
      textSearchSpecification(tsquery),
    );

    const rows = await this.db
      .select(this.candidateColumns(rankExpression))
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(where)
      // Order by raw text rank so that, if the candidate set is truncated at
      // `limit`, what survives is the most textually relevant material.
      .orderBy(desc(rankExpression))
      .limit(limit);

    return rows.map((row) => this.toCandidate(row));
  }

  /** Browse retrieval: no query text, ordered by popularity. */
  async findBrowseCandidates(
    filters: CandidateFilters,
    limit = CANDIDATE_LIMIT,
  ): Promise<(RankingCandidate & { name: string; description: string })[]> {
    const rows = await this.db
      .select(this.candidateColumns(sql<number>`0`))
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(all(...specificationsFor(filters as never)))
      .orderBy(desc(apis.popularityScore))
      .limit(limit);

    return rows.map((row) => this.toCandidate(row));
  }

  /**
   * Fuzzy fallback for queries with no full-text match.
   *
   * Uses ILIKE over name and provider. This is deliberately narrow: it is a
   * rescue path for typos and partial names, not a general search mode.
   */
  async findFuzzyCandidates(
    terms: string[],
    filters: CandidateFilters,
    limit = 50,
  ): Promise<(RankingCandidate & { name: string; description: string })[]> {
    if (terms.length === 0) return [];

    const patterns = terms
      .filter((term) => term.length >= 3)
      .map((term) => or(ilike(apis.name, `%${term}%`), ilike(apis.provider, `%${term}%`)))
      .filter((clause): clause is SQL => clause !== undefined);

    if (patterns.length === 0) return [];

    const rows = await this.db
      .select(this.candidateColumns(sql<number>`0.05`))
      .from(apis)
      .leftJoin(apiHealthLatest, eq(apiHealthLatest.apiId, apis.id))
      .where(and(all(...specificationsFor(filters as never)), or(...patterns)))
      .orderBy(desc(apis.popularityScore))
      .limit(limit);

    return rows.map((row) => this.toCandidate(row));
  }

  /** Typeahead suggestions: names and categories matching a prefix. */
  async suggest(
    prefix: string,
    limit: number,
  ): Promise<{ text: string; type: 'api' | 'category'; slug: string; hint: string | null }[]> {
    const pattern = `${prefix}%`;
    const containsPattern = `%${prefix}%`;

    const [apiRows, categoryRows] = await Promise.all([
      this.db
        .select({ name: apis.name, slug: apis.slug, provider: apis.provider })
        .from(apis)
        .where(
          and(
            eq(apis.status, 'active'),
            or(ilike(apis.name, pattern), ilike(apis.name, containsPattern)),
          ),
        )
        // Prefix matches rank above substring matches.
        .orderBy(sql`(${apis.name} ILIKE ${pattern}) DESC`, desc(apis.popularityScore))
        .limit(limit),

      this.db
        .select({ name: schema.categories.name, slug: schema.categories.slug })
        .from(schema.categories)
        .where(ilike(schema.categories.name, containsPattern))
        .orderBy(desc(schema.categories.apiCount))
        .limit(3),
    ]);

    return [
      ...apiRows.map((row) => ({
        text: row.name,
        type: 'api' as const,
        slug: row.slug,
        hint: row.provider,
      })),
      ...categoryRows.map((row) => ({
        text: row.name,
        type: 'category' as const,
        slug: row.slug,
        hint: 'Category',
      })),
    ];
  }

  /** Candidate names for "did you mean?", scoped to reduce the comparison set. */
  async namesForSpellCheck(limit = 500): Promise<string[]> {
    const rows = await this.db
      .select({ name: apis.name })
      .from(apis)
      .where(eq(apis.status, 'active'))
      .orderBy(desc(apis.popularityScore))
      .limit(limit);

    return rows.map((row) => row.name);
  }

  /** Record a search term for trend analytics (report FR-12). */
  async recordSearch(term: string, resultCount: number): Promise<void> {
    const normalised = term.trim().toLowerCase().slice(0, 100);
    if (normalised.length === 0) return;

    const day = new Date().toISOString().slice(0, 10);

    await this.db
      .insert(schema.searchQueries)
      .values({
        day,
        term: normalised,
        count: 1,
        zeroResultCount: resultCount === 0 ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [schema.searchQueries.day, schema.searchQueries.term],
        set: {
          count: sql`${schema.searchQueries.count} + 1`,
          zeroResultCount: sql`${schema.searchQueries.zeroResultCount} + ${resultCount === 0 ? 1 : 0}`,
        },
      });
  }

  private toCandidate(row: {
    id: string;
    textRank: number;
    popularityScore: number;
    reliabilityScore: number | null;
    latencyMs: number | null;
    updatedAt: Date;
    isFree: boolean;
    hasFreeTier: boolean;
    httpsSupported: boolean;
    docsUrl: string | null;
    name: string;
    description: string;
    hasEndpoints: boolean;
  }): RankingCandidate & { name: string; description: string } {
    return {
      id: row.id,
      textRank: Number(row.textRank ?? 0),
      popularityScore: Number(row.popularityScore ?? 0),
      reliabilityScore: row.reliabilityScore === null ? null : Number(row.reliabilityScore),
      latencyMs: row.latencyMs === null ? null : Number(row.latencyMs),
      updatedAt: row.updatedAt,
      isFree: row.isFree,
      hasFreeTier: row.hasFreeTier,
      hasDocs: Boolean(row.docsUrl),
      hasEndpoints: Boolean(row.hasEndpoints),
      httpsSupported: row.httpsSupported,
      name: row.name,
      description: row.description,
    };
  }
}
