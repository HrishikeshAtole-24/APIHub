/**
 * Admin and operations contracts (report FR-10/FR-12, 16, 32).
 */
import { z } from 'zod';

import { ApiStatusSchema, IsoDateSchema } from './common';

// ── Ingestion (report 16) ─────────────────────────────────────

export const IngestionStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'partial',
]);
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;

/** Audit record for one import run (report 13.1 ingestion_runs, 16.3). */
export const IngestionRunSchema = z.object({
  id: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  /** Content hash of the fetched payload; identical revisions are no-ops. */
  sourceRevision: z.string().nullable(),
  status: IngestionStatusSchema,
  recordsFetched: z.number().int(),
  recordsCreated: z.number().int(),
  recordsUpdated: z.number().int(),
  recordsSkipped: z.number().int(),
  recordsFailed: z.number().int(),
  duplicateClusters: z.number().int(),
  errorMessage: z.string().nullable(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  durationMs: z.number().int().nullable(),
});
export type IngestionRun = z.infer<typeof IngestionRunSchema>;

export const TriggerIngestionSchema = z.object({
  /** Re-import even when the source revision is unchanged. */
  force: z.boolean().default(false),
  /** Parse and report without writing. */
  dryRun: z.boolean().default(false),
  sourceUrl: z.string().url().optional(),
});
export type TriggerIngestion = z.infer<typeof TriggerIngestionSchema>;

// ── Moderation ────────────────────────────────────────────────

export const UpdateApiStatusSchema = z.object({
  status: ApiStatusSchema,
  reason: z.string().max(500).optional(),
});
export type UpdateApiStatus = z.infer<typeof UpdateApiStatusSchema>;

/** Privileged action history (report 19, 13.1 audit_logs). */
export const AuditLogSchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  createdAt: IsoDateSchema,
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

// ── Operational metrics (report 27) ───────────────────────────

export const QueueStatsSchema = z.object({
  name: z.string(),
  waiting: z.number().int(),
  active: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  delayed: z.number().int(),
});
export type QueueStats = z.infer<typeof QueueStatsSchema>;

export const OpsMetricsSchema = z.object({
  uptimeSeconds: z.number(),
  /** Which driver each infrastructure dependency resolved to at boot. */
  drivers: z.object({
    database: z.string(),
    cache: z.string(),
    queue: z.string(),
  }),
  database: z.object({
    reachable: z.boolean(),
    latencyMs: z.number().nullable(),
  }),
  cache: z.object({
    reachable: z.boolean(),
    hitRate: z.number().nullable(),
    size: z.number().int().nullable(),
  }),
  queues: z.array(QueueStatsSchema),
  eventLoopLagMs: z.number(),
  memory: z.object({
    heapUsedMb: z.number(),
    heapTotalMb: z.number(),
    rssMb: z.number(),
  }),
  /** Rolling request counters since process start. */
  http: z.object({
    total: z.number().int(),
    errors: z.number().int(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
  }),
});
export type OpsMetrics = z.infer<typeof OpsMetricsSchema>;

/** Liveness/readiness payload (report 37 Milestone A). */
export const HealthzSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  version: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'degraded', 'error']),
      latencyMs: z.number().nullable(),
      message: z.string().nullable(),
    }),
  ),
});
export type Healthz = z.infer<typeof HealthzSchema>;

// ── Analytics (FR-12) ─────────────────────────────────────────

export const AnalyticsOverviewSchema = z.object({
  topSearches: z.array(z.object({ term: z.string(), count: z.number().int() })),
  topApis: z.array(z.object({ slug: z.string(), name: z.string(), views: z.number().int() })),
  playgroundRuns: z.number().int(),
  searchesTotal: z.number().int(),
  /** Daily series for the activity chart. */
  activity: z.array(
    z.object({ date: z.string(), searches: z.number().int(), views: z.number().int() }),
  ),
});
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;
