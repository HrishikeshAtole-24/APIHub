/**
 * Catalogue contracts: categories, API summaries and API detail
 * (report 5 FR-01/FR-03, 13.1, 31).
 */
import { z } from 'zod';

import {
  ApiStatusSchema,
  AuthTypeSchema,
  CorsStatusSchema,
  HealthStatusSchema,
  IsoDateSchema,
  PaginationQuerySchema,
  SlugSchema,
} from './common';

// ── Categories ────────────────────────────────────────────────

export const CategorySchema = z.object({
  id: z.string(),
  slug: SlugSchema,
  name: z.string(),
  description: z.string().nullable(),
  /** Lucide icon name, chosen at ingestion so the UI stays declarative. */
  icon: z.string().nullable(),
  apiCount: z.number().int().nonnegative(),
});
export type Category = z.infer<typeof CategorySchema>;

// ── Health projection embedded in catalogue responses ─────────

export const ApiHealthSummarySchema = z.object({
  status: HealthStatusSchema,
  /** Latest observed latency in milliseconds. */
  latencyMs: z.number().int().nullable(),
  /** Uptime over the trailing 30 days, 0..1. */
  uptime30d: z.number().min(0).max(1).nullable(),
  /** Composite reliability score 0..100 (report 17.2). */
  reliabilityScore: z.number().min(0).max(100).nullable(),
  lastCheckedAt: IsoDateSchema.nullable(),
  /** Consecutive failed probes; drives the incident banner. */
  consecutiveFailures: z.number().int().nonnegative(),
});
export type ApiHealthSummary = z.infer<typeof ApiHealthSummarySchema>;

// ── API summary (list/card view) ──────────────────────────────

export const ApiSummarySchema = z.object({
  id: z.string(),
  slug: SlugSchema,
  name: z.string(),
  provider: z.string().nullable(),
  description: z.string(),
  categories: z.array(CategorySchema.pick({ id: true, slug: true, name: true })),
  authType: AuthTypeSchema,
  httpsSupported: z.boolean(),
  corsStatus: CorsStatusSchema,
  /** True when the API is usable without any credential at all. */
  isFree: z.boolean(),
  hasFreeTier: z.boolean(),
  docsUrl: z.string().nullable(),
  baseUrl: z.string().nullable(),
  status: ApiStatusSchema,
  popularityScore: z.number().min(0).max(100),
  health: ApiHealthSummarySchema,
  averageRating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  favoriteCount: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  updatedAt: IsoDateSchema,
});
export type ApiSummary = z.infer<typeof ApiSummarySchema>;

// ── Endpoint + auth scheme detail ─────────────────────────────

export const ApiEndpointSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string().nullable(),
  /** Documented query/path parameters, used to prefill the playground. */
  parameters: z.array(
    z.object({
      name: z.string(),
      in: z.enum(['query', 'path', 'header']),
      required: z.boolean(),
      description: z.string().nullable(),
      example: z.string().nullable(),
    }),
  ),
  /** A known-good example response, when one could be captured. */
  sampleResponse: z.string().nullable(),
});
export type ApiEndpoint = z.infer<typeof ApiEndpointSchema>;

export const ApiAuthSchemeSchema = z.object({
  id: z.string(),
  type: AuthTypeSchema,
  /** Where the credential goes: header name, query param name, etc. */
  location: z.enum(['header', 'query', 'body', 'none']),
  parameterName: z.string().nullable(),
  /** Free-form guidance, e.g. "Sign up at example.com to get a key". */
  notes: z.string().nullable(),
  signupUrl: z.string().nullable(),
});
export type ApiAuthScheme = z.infer<typeof ApiAuthSchemeSchema>;

/** Provenance, so every record can be traced upstream (report 16.1 / ADR-010). */
export const ApiProvenanceSchema = z.object({
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  importedAt: IsoDateSchema.nullable(),
  transformVersion: z.string().nullable(),
  license: z.string().nullable(),
});
export type ApiProvenance = z.infer<typeof ApiProvenanceSchema>;

export const ApiDetailSchema = ApiSummarySchema.extend({
  longDescription: z.string().nullable(),
  endpoints: z.array(ApiEndpointSchema),
  authSchemes: z.array(ApiAuthSchemeSchema),
  provenance: ApiProvenanceSchema,
  /** Rate limits as documented upstream, when known. */
  rateLimit: z
    .object({
      requests: z.number().int().nullable(),
      window: z.string().nullable(),
      notes: z.string().nullable(),
    })
    .nullable(),
  /** Related APIs by content similarity, for the "alternatives" panel. */
  alternatives: z.array(ApiSummarySchema.pick({ id: true, slug: true, name: true, description: true })),
  createdAt: IsoDateSchema,
});
export type ApiDetail = z.infer<typeof ApiDetailSchema>;

// ── Catalogue query ───────────────────────────────────────────

export const ApiSortSchema = z
  .enum(['relevance', 'popularity', 'reliability', 'name', 'newest', 'rating'])
  .default('popularity');
export type ApiSort = z.infer<typeof ApiSortSchema>;

/**
 * Filters map 1:1 to URL search parameters so search state stays shareable
 * (report 10.1: "use URL search parameters as shareable search state").
 */
export const ApiListQuerySchema = PaginationQuerySchema.extend({
  q: z.string().max(200).optional(),
  category: z.string().max(96).optional(),
  auth: z.union([AuthTypeSchema, z.literal('any')]).optional(),
  https: z.coerce.boolean().optional(),
  cors: z.coerce.boolean().optional(),
  free: z.coerce.boolean().optional(),
  status: HealthStatusSchema.optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  tags: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  sort: ApiSortSchema,
});
export type ApiListQuery = z.infer<typeof ApiListQuerySchema>;

/** Facet counts so filter chips can show "Free (1,204)" without a second query. */
export const FacetBucketSchema = z.object({
  value: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
});
export type FacetBucket = z.infer<typeof FacetBucketSchema>;

export const ApiFacetsSchema = z.object({
  categories: z.array(FacetBucketSchema),
  auth: z.array(FacetBucketSchema),
  health: z.array(FacetBucketSchema),
  features: z.array(FacetBucketSchema),
});
export type ApiFacets = z.infer<typeof ApiFacetsSchema>;

export const ApiListResultSchema = z.object({
  items: z.array(ApiSummarySchema),
  facets: ApiFacetsSchema.optional(),
});
export type ApiListResult = z.infer<typeof ApiListResultSchema>;

// ── Platform statistics (landing page + admin) ────────────────

export const PlatformStatsSchema = z.object({
  totalApis: z.number().int(),
  totalCategories: z.number().int(),
  freeApis: z.number().int(),
  noAuthApis: z.number().int(),
  httpsApis: z.number().int(),
  monitoredApis: z.number().int(),
  healthyApis: z.number().int(),
  averageLatencyMs: z.number().nullable(),
  lastIngestionAt: IsoDateSchema.nullable(),
});
export type PlatformStats = z.infer<typeof PlatformStatsSchema>;
