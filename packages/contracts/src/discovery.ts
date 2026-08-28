/**
 * Search, comparison and recommendation contracts
 * (report 15, FR-02/FR-05/FR-11, 26).
 */
import { z } from 'zod';

import { ApiListQuerySchema, ApiSummarySchema } from './catalog';
import { AuthTypeSchema } from './common';

// ── Search ────────────────────────────────────────────────────

export const SearchQuerySchema = ApiListQuerySchema.extend({
  q: z.string().min(1).max(200),
  /**
   * lexical = PostgreSQL FTS only (report 15.1)
   * hybrid  = lexical + semantic fused (report 15.2); falls back to lexical
   *           when no embedding provider is configured.
   */
  mode: z.enum(['lexical', 'hybrid']).default('lexical'),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * Per-result score breakdown. Exposed so the UI can answer "why is this
 * ranked here?" — the report's explainability requirement (3, 26.1).
 */
export const ScoreBreakdownSchema = z.object({
  total: z.number(),
  textRelevance: z.number(),
  popularity: z.number(),
  reliability: z.number(),
  freshness: z.number(),
  freeTier: z.number(),
  documentation: z.number(),
  semantic: z.number().nullable(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const SearchHitSchema = z.object({
  api: ApiSummarySchema,
  score: z.number(),
  breakdown: ScoreBreakdownSchema.optional(),
  /** Server-rendered highlight fragments with <mark> around matches. */
  highlights: z
    .object({
      name: z.string().nullable(),
      description: z.string().nullable(),
    })
    .optional(),
  matchedTerms: z.array(z.string()).optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  hits: z.array(SearchHitSchema),
  /** Spelling correction offered when the query returned few results. */
  didYouMean: z.string().nullable(),
  tookMs: z.number(),
  mode: z.enum(['lexical', 'hybrid']),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SuggestQuerySchema = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type SuggestQuery = z.infer<typeof SuggestQuerySchema>;

export const SuggestionSchema = z.object({
  text: z.string(),
  type: z.enum(['api', 'category', 'tag', 'query']),
  slug: z.string().nullable(),
  /** Short context line, e.g. the category an API belongs to. */
  hint: z.string().nullable(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

// ── Comparison (FR-05) ────────────────────────────────────────

export const CompareQuerySchema = z.object({
  slugs: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(2).max(4)),
});
export type CompareQuery = z.infer<typeof CompareQuerySchema>;

/** One row of the comparison matrix. */
export const CompareRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Rendering hint so the UI knows to draw a tick, a bar or plain text. */
  kind: z.enum(['boolean', 'text', 'score', 'latency', 'rating']),
  /** Values indexed identically to `apis`. */
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** Index of the best value, or null when there is no meaningful winner. */
  bestIndex: z.number().int().nullable(),
});
export type CompareRow = z.infer<typeof CompareRowSchema>;

export const CompareResultSchema = z.object({
  apis: z.array(ApiSummarySchema),
  rows: z.array(CompareRowSchema),
  /** Deterministic verdict; explainable without an LLM (report 26.1). */
  verdict: z.object({
    winnerIndex: z.number().int().nullable(),
    reasons: z.array(z.string()),
    /** Per-API total score used to pick the winner. */
    scores: z.array(z.number()),
  }),
});
export type CompareResult = z.infer<typeof CompareResultSchema>;

// ── Recommendations (FR-11) ───────────────────────────────────

export const RecommendRequestSchema = z.object({
  /** Free-text project description, e.g. "an ecommerce app in Node.js". */
  prompt: z.string().min(3).max(1000),
  constraints: z
    .object({
      free: z.boolean().optional(),
      noAuth: z.boolean().optional(),
      httpsOnly: z.boolean().optional(),
      corsRequired: z.boolean().optional(),
      preferredAuth: AuthTypeSchema.optional(),
      categories: z.array(z.string()).max(10).optional(),
    })
    .default({}),
  limit: z.number().int().min(1).max(20).default(6),
});
export type RecommendRequest = z.infer<typeof RecommendRequestSchema>;

export const RecommendationSchema = z.object({
  api: ApiSummarySchema,
  score: z.number(),
  /** Grounded, non-hallucinated bullet reasons derived from catalogue fields. */
  reasons: z.array(z.string()),
  /** Honest caveats, e.g. "requires OAuth2", "no CORS support". */
  caveats: z.array(z.string()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const RecommendResultSchema = z.object({
  recommendations: z.array(RecommendationSchema),
  /** Filters the system inferred from the prompt, shown back to the user. */
  interpretedConstraints: z.object({
    categories: z.array(z.string()),
    free: z.boolean().nullable(),
    noAuth: z.boolean().nullable(),
    httpsOnly: z.boolean().nullable(),
    keywords: z.array(z.string()),
  }),
  /**
   * Optional natural-language summary. Present only when an AI provider is
   * configured; the recommendations themselves are always deterministic.
   */
  narrative: z.string().nullable(),
  /** True when the narrative came from an LLM rather than the template engine. */
  aiGenerated: z.boolean(),
  tookMs: z.number(),
});
export type RecommendResult = z.infer<typeof RecommendResultSchema>;

/** Project-stack recommendation: a set of APIs grouped by concern. */
export const StackSuggestionSchema = z.object({
  concern: z.string(),
  description: z.string(),
  options: z.array(ApiSummarySchema),
});
export type StackSuggestion = z.infer<typeof StackSuggestionSchema>;
