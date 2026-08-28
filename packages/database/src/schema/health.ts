/**
 * Health monitoring schema (report 17, 13.1, 31.1).
 *
 * Three tiers, because the access patterns are completely different:
 *
 *   api_health_checks  raw append-only observations, retained 30-90 days.
 *   api_health_daily   one row per API per day; retained indefinitely.
 *   api_health_latest  exactly one row per API; the hot read path.
 *
 * Without `api_health_latest`, rendering a catalogue page of 24 APIs would
 * need 24 correlated "most recent check" subqueries. This is the precomputed
 * aggregate the report calls for in 33.1.
 */
import { relations } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { apis } from './catalog.js';

// ── Raw probe observations ────────────────────────────────────

export const apiHealthChecks = pgTable(
  'api_health_checks',
  {
    id: text('id').primaryKey(),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    /** 'unknown' | 'up' | 'degraded' | 'down' */
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    /** Classified failure, e.g. DNS_FAILURE, TIMEOUT, TLS_ERROR, BLOCKED_ADDRESS. */
    errorCode: text('error_code'),
    /** Bytes received. Bounded metadata only; bodies are never stored (report 17.2). */
    responseBytes: integer('response_bytes'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The report's prescribed index for "recent checks for this API".
    index('api_health_checks_api_time_idx').on(table.apiId, table.checkedAt.desc()),
    // Supports the retention sweep, which deletes by age across all APIs.
    index('api_health_checks_time_idx').on(table.checkedAt),
  ],
);

// ── Daily aggregates ──────────────────────────────────────────

export const apiHealthDaily = pgTable(
  'api_health_daily',
  {
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    totalChecks: integer('total_checks').notNull().default(0),
    successfulChecks: integer('successful_checks').notNull().default(0),
    uptime: real('uptime').notNull().default(0),
    avgLatencyMs: real('avg_latency_ms'),
    p95LatencyMs: real('p95_latency_ms'),
    incidents: integer('incidents').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.apiId, table.day] }),
    index('api_health_daily_day_idx').on(table.day),
  ],
);

// ── Latest status (hot path) ──────────────────────────────────

export const apiHealthLatest = pgTable(
  'api_health_latest',
  {
    apiId: text('api_id')
      .primaryKey()
      .references(() => apis.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('unknown'),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    /** Drives the state machine and the incident threshold (report 17.1). */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    uptime30d: real('uptime_30d'),
    successRate7d: real('success_rate_7d'),
    /** Composite 0..100 (report 17.2). Denormalised onto this row for sorting. */
    reliabilityScore: real('reliability_score'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** When the next probe is due; the scheduler's primary query. */
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    /** Higher runs sooner. Feeds the priority queue (report 21). */
    checkPriority: integer('check_priority').notNull().default(100),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_health_latest_status_idx').on(table.status),
    index('api_health_latest_reliability_idx').on(table.reliabilityScore),
    // The scheduler asks "what is due now, highest priority first".
    index('api_health_latest_due_idx').on(table.nextCheckAt, table.checkPriority.desc()),
  ],
);

// ── Incidents ─────────────────────────────────────────────────

export const incidents = pgTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    checksAffected: integer('checks_affected').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    index('incidents_api_time_idx').on(table.apiId, table.startedAt.desc()),
    // Open incidents: the dashboard's "what is broken right now" query.
    index('incidents_unresolved_idx').on(table.resolvedAt),
  ],
);

export const apiHealthLatestRelations = relations(apiHealthLatest, ({ one }) => ({
  api: one(apis, { fields: [apiHealthLatest.apiId], references: [apis.id] }),
}));

export const apiHealthChecksRelations = relations(apiHealthChecks, ({ one }) => ({
  api: one(apis, { fields: [apiHealthChecks.apiId], references: [apis.id] }),
}));

export const incidentsRelations = relations(incidents, ({ one }) => ({
  api: one(apis, { fields: [incidents.apiId], references: [apis.id] }),
}));

export type HealthCheckRow = typeof apiHealthChecks.$inferSelect;
export type HealthLatestRow = typeof apiHealthLatest.$inferSelect;
export type HealthDailyRow = typeof apiHealthDaily.$inferSelect;
export type IncidentRow = typeof incidents.$inferSelect;
