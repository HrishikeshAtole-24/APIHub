/**
 * Operations schema: ingestion audit, security audit and analytics
 * (report 13.1, 16.3, 19, FR-12).
 */
import { relations } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { apiSources, apis } from './catalog.js';
import { users } from './users.js';

// ── Ingestion audit (report 16.3) ─────────────────────────────

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').references(() => apiSources.id, { onDelete: 'set null' }),
    sourceName: text('source_name').notNull(),
    sourceUrl: text('source_url'),
    /**
     * Content hash of the fetched payload. Re-running against an identical
     * revision is a no-op, which is what makes ingestion idempotent.
     */
    sourceRevision: text('source_revision'),
    /** 'queued' | 'running' | 'succeeded' | 'failed' | 'partial' */
    status: text('status').notNull().default('queued'),

    recordsFetched: integer('records_fetched').notNull().default(0),
    recordsCreated: integer('records_created').notNull().default(0),
    recordsUpdated: integer('records_updated').notNull().default(0),
    recordsSkipped: integer('records_skipped').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),
    duplicateClusters: integer('duplicate_clusters').notNull().default(0),

    errorMessage: text('error_message'),
    /** Per-record failures, capped, for operator diagnosis. */
    failures: jsonb('failures').$type<{ record: string; reason: string }[]>().notNull().default([]),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    index('ingestion_runs_time_idx').on(table.startedAt.desc()),
    index('ingestion_runs_source_idx').on(table.sourceId, table.startedAt.desc()),
  ],
);

// ── Security / admin audit (report 19) ────────────────────────

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    /** Null for system-initiated actions. */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalised so the log survives account deletion. */
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_time_idx').on(table.createdAt.desc()),
    index('audit_logs_actor_idx').on(table.actorId, table.createdAt.desc()),
    index('audit_logs_entity_idx').on(table.entityType, table.entityId),
  ],
);

// ── Analytics (report FR-12) ──────────────────────────────────

/**
 * Search terms, aggregated by day rather than stored per event.
 *
 * Per-event storage would make this the fastest-growing table in the system
 * for very little analytical gain, and it would hold a per-user trail of
 * queries. Day-level counters answer "what is trending" without either cost.
 */
export const searchQueries = pgTable(
  'search_queries',
  {
    day: date('day').notNull(),
    /** Normalised query term. */
    term: text('term').notNull(),
    count: integer('count').notNull().default(0),
    /** Number of times the query returned nothing; drives content gap analysis. */
    zeroResultCount: integer('zero_result_count').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.term] }),
    index('search_queries_day_count_idx').on(table.day, table.count.desc()),
  ],
);

export const apiViews = pgTable(
  'api_views',
  {
    day: date('day').notNull(),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    views: integer('views').notNull().default(0),
    playgroundRuns: integer('playground_runs').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.apiId] }),
    index('api_views_day_idx').on(table.day, table.views.desc()),
    index('api_views_api_idx').on(table.apiId),
  ],
);

/**
 * Playground execution log.
 *
 * Deliberately narrow: no headers, no bodies, no URLs beyond the host. Enough
 * to detect abuse and report usage, nothing that could carry a credential
 * (report 20.1, 37 Milestone C).
 */
export const playgroundRuns = pgTable(
  'playground_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    apiId: text('api_id').references(() => apis.id, { onDelete: 'set null' }),
    method: text('method').notNull(),
    /** Hostname only. Never the full URL. */
    targetHost: text('target_host').notNull(),
    responseStatus: integer('response_status'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('playground_runs_time_idx').on(table.createdAt.desc()),
    index('playground_runs_user_idx').on(table.userId, table.createdAt.desc()),
  ],
);

export const ingestionRunsRelations = relations(ingestionRuns, ({ one }) => ({
  source: one(apiSources, { fields: [ingestionRuns.sourceId], references: [apiSources.id] }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, { fields: [auditLogs.actorId], references: [users.id] }),
}));

export type IngestionRunRow = typeof ingestionRuns.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
