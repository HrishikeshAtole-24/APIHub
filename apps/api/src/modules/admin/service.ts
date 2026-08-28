/**
 * Admin and operations service (report FR-10, FR-12, 27, 32).
 */
import type {
  AnalyticsOverview,
  AuditLog,
  Healthz,
  IngestionRun,
  OpsMetrics,
} from '@apihub/contracts';
import { schema, type Database, type DatabaseHandle } from '@apihub/database';
import {
  allQueueStats,
  eventLoopLagMs,
  events,
  getQueue,
  metrics,
  type CacheService,
} from '@apihub/runtime';
import { QUEUE_NAMES } from '@apihub/config';
import { desc, eq, gte, sql } from 'drizzle-orm';

import { NotFoundError } from '../../shared/errors.js';

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheService,
    private readonly handle: DatabaseHandle,
  ) {}

  // ── Health checks ───────────────────────────────────────────

  /**
   * Readiness probe (report 37 Milestone A).
   *
   * The database is a HARD dependency: without it the API cannot serve
   * anything. The cache is SOFT: losing Redis degrades performance but the
   * platform still works, so it reports "degraded", not "error".
   */
  async healthz(): Promise<Healthz> {
    const checks: Healthz['checks'] = [];

    try {
      const latencyMs = await this.handle.ping();
      checks.push({
        name: 'database',
        status: latencyMs < 1000 ? 'ok' : 'degraded',
        latencyMs: Math.round(latencyMs * 100) / 100,
        message: `driver=${this.handle.driver}`,
      });
    } catch (error) {
      checks.push({
        name: 'database',
        status: 'error',
        latencyMs: null,
        message: error instanceof Error ? error.message : 'unreachable',
      });
    }

    try {
      const healthy = await this.cache.isHealthy();
      checks.push({
        name: 'cache',
        status: healthy ? 'ok' : 'degraded',
        latencyMs: null,
        message: this.cache.storeName,
      });
    } catch {
      checks.push({ name: 'cache', status: 'degraded', latencyMs: null, message: 'unreachable' });
    }

    const hasError = checks.some((check) => check.status === 'error');
    const hasDegraded = checks.some((check) => check.status === 'degraded');

    return {
      status: hasError ? 'error' : hasDegraded ? 'degraded' : 'ok',
      version: process.env['npm_package_version'] ?? '0.1.0',
      checks,
    };
  }

  async opsMetrics(): Promise<OpsMetrics> {
    const memory = process.memoryUsage();
    const snapshot = metrics.snapshot();

    let databaseLatency: number | null = null;
    let databaseReachable = true;
    try {
      databaseLatency = await this.handle.ping();
    } catch {
      databaseReachable = false;
    }

    const cacheStats = await this.cache.stats().catch(() => null);
    const queues = await allQueueStats().catch(() => []);

    const httpHistogram = Object.entries(snapshot.histograms).filter(([key]) =>
      key.startsWith('http_request_duration_ms'),
    );
    const totalRequests = Object.entries(snapshot.counters)
      .filter(([key]) => key.startsWith('http_requests_total'))
      .reduce((sum, [, value]) => sum + value, 0);
    const totalErrors = Object.entries(snapshot.counters)
      .filter(([key]) => key.startsWith('http_errors_total'))
      .reduce((sum, [, value]) => sum + value, 0);

    // Aggregate p50/p95 across route series by taking the worst observed.
    const p50 = httpHistogram.reduce<number | null>(
      (worst, [, h]) => (h.p50 === null ? worst : Math.max(worst ?? 0, h.p50)),
      null,
    );
    const p95 = httpHistogram.reduce<number | null>(
      (worst, [, h]) => (h.p95 === null ? worst : Math.max(worst ?? 0, h.p95)),
      null,
    );

    return {
      uptimeSeconds: Math.round(metrics.uptimeSeconds),
      drivers: {
        database: this.handle.driver,
        cache: this.cache.storeName,
        queue: queues[0] ? 'active' : 'idle',
      },
      database: {
        reachable: databaseReachable,
        latencyMs: databaseLatency === null ? null : Math.round(databaseLatency * 100) / 100,
      },
      cache: {
        reachable: cacheStats !== null,
        hitRate: cacheStats?.hitRate ?? null,
        size: cacheStats?.size ?? null,
      },
      queues: queues.map((queue) => ({
        name: queue.name,
        waiting: queue.waiting,
        active: queue.active,
        completed: queue.completed,
        failed: queue.failed,
        delayed: queue.delayed,
      })),
      eventLoopLagMs: Math.round(eventLoopLagMs() * 100) / 100,
      memory: {
        heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotalMb: Math.round((memory.heapTotal / 1024 / 1024) * 10) / 10,
        rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      },
      http: { total: totalRequests, errors: totalErrors, p50Ms: p50, p95Ms: p95 },
    };
  }

  // ── Ingestion control ───────────────────────────────────────

  async listIngestionRuns(limit = 20): Promise<IngestionRun[]> {
    const rows = await this.db
      .select()
      .from(schema.ingestionRuns)
      .orderBy(desc(schema.ingestionRuns.startedAt))
      .limit(limit);

    return rows.map(toIngestionRun);
  }

  /**
   * Queue an ingestion run.
   *
   * The API only ENQUEUES; the worker performs the import. A multi-minute
   * network-bound job must never run on the request path (report 33.2).
   */
  async triggerIngestion(input: {
    force: boolean;
    dryRun: boolean;
    sourceUrl?: string;
  }): Promise<{ jobId: string }> {
    const queue = await getQueue(QUEUE_NAMES.ingestionImport);
    const jobId = await queue.add('ingestion.import', input, { attempts: 2, backoffMs: 5000 });
    return { jobId };
  }

  async triggerReindex(): Promise<{ jobId: string }> {
    const queue = await getQueue(QUEUE_NAMES.searchReindex);
    const jobId = await queue.add('search.reindex', { reason: 'manual' }, { attempts: 2 });
    events.emitAsync('search.reindex_requested', { reason: 'manual' });
    return { jobId };
  }

  // ── Moderation ──────────────────────────────────────────────

  async updateApiStatus(
    slug: string,
    status: string,
    actor: { id: string; email: string },
    reason?: string,
  ): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.apis.id, status: schema.apis.status })
      .from(schema.apis)
      .where(eq(schema.apis.slug, slug))
      .limit(1);

    if (!existing) throw new NotFoundError('API');

    await this.db
      .update(schema.apis)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.apis.id, existing.id));

    await this.audit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'api.status_changed',
      entityType: 'api',
      entityId: existing.id,
      metadata: { from: existing.status, to: status, reason: reason ?? null },
    });

    events.emitAsync('api.status_changed', {
      apiId: existing.id,
      slug,
      from: existing.status,
      to: status,
    });
  }

  /** Append to the privileged-action log (report 19). */
  async audit(entry: {
    actorId: string | null;
    actorEmail: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.db.insert(schema.auditLogs).values({
      id: schema.newId('audit'),
      actorId: entry.actorId,
      actorEmail: entry.actorEmail,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent?.slice(0, 200) ?? null,
    });
  }

  async listAuditLogs(limit = 50): Promise<AuditLog[]> {
    const rows = await this.db
      .select()
      .from(schema.auditLogs)
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ── Analytics ───────────────────────────────────────────────

  async analytics(days = 14): Promise<AnalyticsOverview> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    const [topSearches, topApis, activity, totals] = await Promise.all([
      this.db
        .select({
          term: schema.searchQueries.term,
          total: sql<number>`sum(${schema.searchQueries.count})`,
        })
        .from(schema.searchQueries)
        .where(gte(schema.searchQueries.day, since))
        .groupBy(schema.searchQueries.term)
        .orderBy(desc(sql`sum(${schema.searchQueries.count})`))
        .limit(10),

      this.db
        .select({
          slug: schema.apis.slug,
          name: schema.apis.name,
          views: sql<number>`sum(${schema.apiViews.views})`,
        })
        .from(schema.apiViews)
        .innerJoin(schema.apis, eq(schema.apis.id, schema.apiViews.apiId))
        .where(gte(schema.apiViews.day, since))
        .groupBy(schema.apis.slug, schema.apis.name)
        .orderBy(desc(sql`sum(${schema.apiViews.views})`))
        .limit(10),

      this.db
        .select({
          date: schema.apiViews.day,
          views: sql<number>`sum(${schema.apiViews.views})`,
        })
        .from(schema.apiViews)
        .where(gte(schema.apiViews.day, since))
        .groupBy(schema.apiViews.day)
        .orderBy(schema.apiViews.day),

      this.db
        .select({
          searches: sql<number>`coalesce(sum(${schema.searchQueries.count}), 0)`,
        })
        .from(schema.searchQueries)
        .where(gte(schema.searchQueries.day, since)),
    ]);

    const [playgroundRow] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.playgroundRuns);

    return {
      topSearches: topSearches.map((row) => ({ term: row.term, count: Number(row.total) })),
      topApis: topApis.map((row) => ({
        slug: row.slug,
        name: row.name,
        views: Number(row.views),
      })),
      playgroundRuns: Number(playgroundRow?.value ?? 0),
      searchesTotal: Number(totals[0]?.searches ?? 0),
      activity: activity.map((row) => ({
        date: String(row.date),
        searches: 0,
        views: Number(row.views),
      })),
    };
  }
}

function toIngestionRun(row: typeof schema.ingestionRuns.$inferSelect): IngestionRun {
  return {
    id: row.id,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    sourceRevision: row.sourceRevision,
    status: row.status as IngestionRun['status'],
    recordsFetched: row.recordsFetched,
    recordsCreated: row.recordsCreated,
    recordsUpdated: row.recordsUpdated,
    recordsSkipped: row.recordsSkipped,
    recordsFailed: row.recordsFailed,
    duplicateClusters: row.duplicateClusters,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
  };
}
