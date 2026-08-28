/**
 * Filter specifications (Specification pattern, report 22).
 *
 * "Composable filters: FreeSpecification, HttpsSpecification"
 *
 * Each specification knows how to express one business rule as a SQL
 * predicate. The repository composes them with AND rather than growing a long
 * chain of `if (query.x) conditions.push(...)`, which means:
 *
 *   - each rule is independently testable,
 *   - the same rule is reused by list, search, facet-count and recommendation
 *     queries and cannot drift between them,
 *   - adding a filter is adding a specification, not editing four queries.
 */
import { schema } from '@apihub/database';
import type { ApiListQuery } from '@apihub/contracts';
import { and, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';

const { apis, apiHealthLatest } = schema;

export interface Specification {
  readonly name: string;
  toSql(): SQL | undefined;
}

function spec(name: string, build: () => SQL | undefined): Specification {
  return { name, toSql: build };
}

/** Only catalogue entries that are live. Applied to every public query. */
export const ActiveSpecification = spec('active', () => eq(apis.status, 'active'));

/** Usable with no credential at all. */
export const FreeSpecification = spec('free', () => eq(apis.isFree, true));

export const HttpsSpecification = spec('https', () => eq(apis.httpsSupported, true));

/** Browser-callable: the upstream sends permissive CORS headers. */
export const CorsSpecification = spec('cors', () => eq(apis.corsStatus, 'yes'));

export function authTypeSpecification(authType: string): Specification {
  return spec('authType', () =>
    authType === 'none'
      ? // "No auth" should also match records flagged free but typed unknown,
        // which is common in the upstream dataset.
        or(eq(apis.authType, 'none'), and(eq(apis.isFree, true), eq(apis.authType, 'unknown')))
      : eq(apis.authType, authType),
  );
}

export function healthStatusSpecification(status: string): Specification {
  return spec('health', () => eq(apiHealthLatest.status, status));
}

export function categorySpecification(categoryId: string): Specification {
  return spec('category', () =>
    // EXISTS rather than a join: a join would multiply rows when an API belongs
    // to several categories, breaking both COUNT and LIMIT.
    sql`EXISTS (
      SELECT 1 FROM ${schema.apiCategories} ac
      WHERE ac.api_id = ${apis.id} AND ac.category_id = ${categoryId}
    )`,
  );
}

export function categorySlugSpecification(slug: string): Specification {
  return spec('categorySlug', () =>
    sql`EXISTS (
      SELECT 1 FROM ${schema.apiCategories} ac
      JOIN ${schema.categories} c ON c.id = ac.category_id
      WHERE ac.api_id = ${apis.id} AND c.slug = ${slug}
    )`,
  );
}

/** Match any of the given tags, using the GIN index over the jsonb array. */
export function tagsSpecification(tags: string[]): Specification {
  return spec('tags', () => {
    if (tags.length === 0) return undefined;
    return sql`${apis.tags} ?| ${sql.raw(`ARRAY[${tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')}]`)}`;
  });
}

export function idsSpecification(ids: string[]): Specification {
  return spec('ids', () => (ids.length === 0 ? sql`false` : inArray(apis.id, ids)));
}

export function slugsSpecification(slugs: string[]): Specification {
  return spec('slugs', () => (slugs.length === 0 ? sql`false` : inArray(apis.slug, slugs)));
}

export function minReliabilitySpecification(minimum: number): Specification {
  return spec('minReliability', () => gte(apiHealthLatest.reliabilityScore, minimum));
}

/** Full-text match against the weighted tsvector (report 15.1). */
export function textSearchSpecification(tsquery: string): Specification {
  return spec('text', () =>
    tsquery.length === 0
      ? undefined
      : sql`${apis.searchVector} @@ to_tsquery('english', ${tsquery})`,
  );
}

/** Combine specifications with AND, dropping any that produce no predicate. */
export function all(...specifications: (Specification | undefined | false)[]): SQL | undefined {
  const clauses = specifications
    .filter((s): s is Specification => Boolean(s))
    .map((s) => s.toSql())
    .filter((clause): clause is SQL => clause !== undefined);

  if (clauses.length === 0) return undefined;
  return and(...clauses);
}

/**
 * Translate a validated list query into the set of specifications it implies.
 * This is the single place the public filter contract meets SQL.
 */
export function specificationsFor(
  query: Partial<ApiListQuery> & { categoryId?: string },
): Specification[] {
  const specs: Specification[] = [ActiveSpecification];

  if (query.free) specs.push(FreeSpecification);
  if (query.https) specs.push(HttpsSpecification);
  if (query.cors) specs.push(CorsSpecification);
  if (query.auth && query.auth !== 'any') specs.push(authTypeSpecification(query.auth));
  if (query.status) specs.push(healthStatusSpecification(query.status));
  if (query.categoryId) specs.push(categorySpecification(query.categoryId));
  else if (query.category) specs.push(categorySlugSpecification(query.category));
  if (query.tags && query.tags.length > 0) specs.push(tagsSpecification(query.tags));

  return specs;
}
