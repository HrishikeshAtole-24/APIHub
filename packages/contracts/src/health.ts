/**
 * Health monitoring contracts (report 17, FR-08).
 */
import { z } from 'zod';

import { HealthStatusSchema, IsoDateSchema } from './common';

/** A single probe observation. Bounded metadata only — never response bodies (report 17.2). */
export const HealthCheckSchema = z.object({
  id: z.string(),
  apiId: z.string(),
  status: HealthStatusSchema,
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  checkedAt: IsoDateSchema,
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** One day of aggregated observations (report 13.1 api_health_daily). */
export const HealthDailySchema = z.object({
  date: z.string(),
  totalChecks: z.number().int(),
  successfulChecks: z.number().int(),
  uptime: z.number().min(0).max(1),
  avgLatencyMs: z.number().nullable(),
  p95LatencyMs: z.number().nullable(),
  incidents: z.number().int(),
});
export type HealthDaily = z.infer<typeof HealthDailySchema>;

/** An observed outage window, derived from consecutive DOWN observations. */
export const IncidentSchema = z.object({
  id: z.string(),
  apiId: z.string(),
  status: HealthStatusSchema,
  startedAt: IsoDateSchema,
  resolvedAt: IsoDateSchema.nullable(),
  durationMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  checksAffected: z.number().int(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const HealthReportSchema = z.object({
  apiId: z.string(),
  current: z.object({
    status: HealthStatusSchema,
    latencyMs: z.number().int().nullable(),
    httpStatus: z.number().int().nullable(),
    lastCheckedAt: IsoDateSchema.nullable(),
    consecutiveFailures: z.number().int(),
  }),
  /** Composite score 0..100 with its component parts, so the UI can explain it. */
  reliability: z.object({
    score: z.number().min(0).max(100),
    uptime30d: z.number().min(0).max(1).nullable(),
    successRate7d: z.number().min(0).max(1).nullable(),
    latencyScore: z.number().min(0).max(1).nullable(),
    freshness: z.number().min(0).max(1),
    incidentPenalty: z.number().min(0).max(1),
  }),
  /** Trailing daily aggregates, oldest first, for the uptime bar chart. */
  history: z.array(HealthDailySchema),
  /** Most recent raw probes, for the latency sparkline. */
  recentChecks: z.array(HealthCheckSchema),
  incidents: z.array(IncidentSchema),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

export const HealthQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export type HealthQuery = z.infer<typeof HealthQuerySchema>;

/** Status-board row for the monitoring dashboard. */
export const HealthBoardEntrySchema = z.object({
  apiId: z.string(),
  slug: z.string(),
  name: z.string(),
  status: HealthStatusSchema,
  latencyMs: z.number().int().nullable(),
  uptime30d: z.number().min(0).max(1).nullable(),
  reliabilityScore: z.number().min(0).max(100).nullable(),
  lastCheckedAt: IsoDateSchema.nullable(),
  /** Compact latency series (newest last) driving the inline sparkline. */
  sparkline: z.array(z.number().int()),
});
export type HealthBoardEntry = z.infer<typeof HealthBoardEntrySchema>;

export const HealthBoardSchema = z.object({
  entries: z.array(HealthBoardEntrySchema),
  summary: z.object({
    total: z.number().int(),
    up: z.number().int(),
    degraded: z.number().int(),
    down: z.number().int(),
    unknown: z.number().int(),
    avgLatencyMs: z.number().nullable(),
    overallUptime: z.number().min(0).max(1).nullable(),
  }),
});
export type HealthBoard = z.infer<typeof HealthBoardSchema>;
