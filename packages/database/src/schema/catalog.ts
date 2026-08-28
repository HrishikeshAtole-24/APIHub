/**
 * Catalogue schema: sources, categories, APIs, endpoints and auth schemes
 * (report 13.1, 13.2, 31).
 *
 * Indexing follows report 13.3: a unique index on slug, composite indexes on
 * the columns the list page actually filters and sorts by, a GIN index over
 * the full-text vector, and partial indexes restricted to active rows so the
 * common query never pays for retired records.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { tsvector } from './types.js';

// ── Sources and provenance (report 16.1, ADR-010) ─────────────

export const apiSources = pgTable('api_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url'),
  license: text('license'),
  /** Version of the transformation code that produced records from this source. */
  transformVersion: text('transform_version').notNull().default('1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Categories ────────────────────────────────────────────────

export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Lucide icon name resolved at ingestion so the UI stays declarative. */
    icon: text('icon'),
    /** Denormalised count, refreshed by the reindex job. Avoids a GROUP BY per page. */
    apiCount: integer('api_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('categories_slug_idx').on(table.slug),
    index('categories_name_idx').on(table.name),
  ],
);

// ── APIs ──────────────────────────────────────────────────────

export const apis = pgTable(
  'apis',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    provider: text('provider'),
    description: text('description').notNull().default(''),
    longDescription: text('long_description'),

    docsUrl: text('docs_url'),
    baseUrl: text('base_url'),

    /** Matches the AuthType contract enum. Stored as text for forward-compatibility. */
    authType: text('auth_type').notNull().default('unknown'),
    httpsSupported: boolean('https_supported').notNull().default(false),
    /** 'yes' | 'no' | 'unknown' */
    corsStatus: text('cors_status').notNull().default('unknown'),

    /** Usable with no credential at all. */
    isFree: boolean('is_free').notNull().default(false),
    /** Has a free tier, possibly requiring a key. */
    hasFreeTier: boolean('has_free_tier').notNull().default(false),

    /** 'active' | 'pending' | 'deprecated' | 'retired' | 'rejected' */
    status: text('status').notNull().default('active'),

    /** 0..100, recomputed by the analytics aggregate job. */
    popularityScore: real('popularity_score').notNull().default(0),

    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    rateLimit: jsonb('rate_limit').$type<{
      requests: number | null;
      window: string | null;
      notes: string | null;
    } | null>(),

    // Provenance
    sourceId: text('source_id').references(() => apiSources.id, { onDelete: 'set null' }),
    /** Identifier of this record within its source, for traceability. */
    sourceRecordId: text('source_record_id'),
    sourceRevision: text('source_revision'),
    /** Stable content hash; drives idempotent upserts (report 16.3). */
    fingerprint: text('fingerprint').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }),

    /**
     * Weighted full-text vector (report 15.1). Populated by the reindex job:
     * name gets weight A, provider/tags B, description C, long text D.
     */
    searchVector: tsvector('search_vector'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('apis_slug_idx').on(table.slug),
    uniqueIndex('apis_fingerprint_idx').on(table.fingerprint),

    // The catalogue's default ordering (report 13.3).
    index('apis_status_updated_idx').on(table.status, table.updatedAt.desc()),
    index('apis_status_popularity_idx').on(table.status, table.popularityScore.desc()),

    // Partial index: the list page only ever queries active rows, so keeping
    // retired records out of the index makes it materially smaller.
    index('apis_active_popularity_idx')
      .on(table.popularityScore.desc())
      .where(sql`${table.status} = 'active'`),

    // Filter facets.
    index('apis_auth_type_idx').on(table.authType),
    index('apis_free_idx').on(table.isFree),

    // GIN over the tsvector powers `@@ to_tsquery(...)`.
    index('apis_search_vector_idx').using('gin', table.searchVector),
    // GIN over the jsonb tag array powers tag filtering.
    index('apis_tags_idx').using('gin', table.tags),

    index('apis_source_idx').on(table.sourceId),
  ],
);

// ── API <-> Category (many-to-many, report 13.2) ──────────────

export const apiCategories = pgTable(
  'api_category_map',
  {
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** True for the API's primary category, used for breadcrumbs. */
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.apiId, table.categoryId] }),
    // Reverse lookup: "all APIs in this category", the most common browse query.
    index('api_category_category_idx').on(table.categoryId, table.apiId),
  ],
);

// ── Endpoints ─────────────────────────────────────────────────

export const apiEndpoints = pgTable(
  'api_endpoints',
  {
    id: text('id').primaryKey(),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    method: text('method').notNull().default('GET'),
    path: text('path').notNull(),
    summary: text('summary'),
    parameters: jsonb('parameters')
      .$type<
        {
          name: string;
          in: 'query' | 'path' | 'header';
          required: boolean;
          description: string | null;
          example: string | null;
        }[]
      >()
      .notNull()
      .default([]),
    sampleResponse: text('sample_response'),
    /** Ordering within the API's endpoint list. */
    position: integer('position').notNull().default(0),
    /** The endpoint the health probe targets. Exactly one per API, by convention. */
    isProbeTarget: boolean('is_probe_target').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('api_endpoints_api_idx').on(table.apiId, table.position)],
);

// ── Auth schemes ──────────────────────────────────────────────

export const apiAuthSchemes = pgTable(
  'api_auth_schemes',
  {
    id: text('id').primaryKey(),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('unknown'),
    /** 'header' | 'query' | 'body' | 'none' */
    location: text('location').notNull().default('none'),
    parameterName: text('parameter_name'),
    notes: text('notes'),
    signupUrl: text('signup_url'),
  },
  (table) => [index('api_auth_schemes_api_idx').on(table.apiId)],
);

// ── Embeddings (report 26.4) ──────────────────────────────────

/**
 * Semantic vectors kept in their own table, and versioned by model.
 *
 * Stored as jsonb rather than a pgvector column so the schema works on every
 * driver including embedded PGlite. On Neon, migration 0002 optionally adds a
 * real `vector` column and an HNSW index; the repository detects which is
 * available. Versioning by model means a model change triggers a controlled
 * re-embedding job rather than silently mixing vector spaces.
 */
export const apiEmbeddings = pgTable(
  'api_embeddings',
  {
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: jsonb('embedding').$type<number[]>().notNull(),
    /** Hash of the text that was embedded, so unchanged text is not re-embedded. */
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.apiId, table.model] })],
);

// ── Relations ─────────────────────────────────────────────────

export const apisRelations = relations(apis, ({ one, many }) => ({
  source: one(apiSources, { fields: [apis.sourceId], references: [apiSources.id] }),
  categories: many(apiCategories),
  endpoints: many(apiEndpoints),
  authSchemes: many(apiAuthSchemes),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  apis: many(apiCategories),
}));

export const apiCategoriesRelations = relations(apiCategories, ({ one }) => ({
  api: one(apis, { fields: [apiCategories.apiId], references: [apis.id] }),
  category: one(categories, { fields: [apiCategories.categoryId], references: [categories.id] }),
}));

export const apiEndpointsRelations = relations(apiEndpoints, ({ one }) => ({
  api: one(apis, { fields: [apiEndpoints.apiId], references: [apis.id] }),
}));

export const apiAuthSchemesRelations = relations(apiAuthSchemes, ({ one }) => ({
  api: one(apis, { fields: [apiAuthSchemes.apiId], references: [apis.id] }),
}));

export type ApiRow = typeof apis.$inferSelect;
export type NewApiRow = typeof apis.$inferInsert;
export type CategoryRow = typeof categories.$inferSelect;
export type ApiEndpointRow = typeof apiEndpoints.$inferSelect;
export type ApiAuthSchemeRow = typeof apiAuthSchemes.$inferSelect;
export type ApiSourceRow = typeof apiSources.$inferSelect;
