/**
 * Health monitoring jobs (report 17).
 *
 *   Scheduler -> queue: health.probe -> Worker -> validate -> HTTP -> measure
 *             -> classify -> persist observation -> update latest -> aggregate
 *
 * Idempotency (report 25): re-running a probe simply records another
 * observation. The state machine is driven by the stored counters, not by
 * job-local state, so a duplicated job cannot corrupt anything.
 */
import { PriorityQueue } from '@apihub/algorithms';
import { getConfig } from '@apihub/config';
import {
  classifyProbe,
  computeCheckPriority,
  computeNextCheckDelay,
  computeReliability,
  percentile,
  transition,
  type HealthState,
} from '@apihub/domain';
import { schema, type DatabaseHandle } from '@apihub/database';
import { getLogger } from '@apihub/logger';
import { events, mapWithConcurrency, withLock, type LockProvider } from '@apihub/runtime';
import { and, count, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';

import { probe, type ProbeTarget } from '../probe/http-probe.js';

const log = getLogger('worker.health');

/**
 * Select the APIs due for a probe.
 *
 * Ordered by due time, then priority. A PriorityQueue then re-orders the batch
 * in memory so that, if capacity is short, the most important checks run first
 * (report 21: "Schedule high-priority health jobs").
 */
export async function selectDueTargets(
  handle: DatabaseHandle,
  limit: number,
): Promise<ProbeTarget[]> {
  const now = new Date();

  const rows = await handle.db
    .select({
      apiId: schema.apis.id,
      slug: schema.apis.slug,
      docsUrl: schema.apis.docsUrl,
      baseUrl: schema.apis.baseUrl,
      priority: schema.apiHealthLatest.checkPriority,
      popularity: schema.apis.popularityScore,
      status: schema.apiHealthLatest.status,
      failures: schema.apiHealthLatest.consecutiveFailures,
    })
    .from(schema.apis)
    .leftJoin(schema.apiHealthLatest, eq(schema.apiHealthLatest.apiId, schema.apis.id))
    .where(
      and(
        eq(schema.apis.status, 'active'),
        or(
          isNull(schema.apiHealthLatest.nextCheckAt),
          lte(schema.apiHealthLatest.nextCheckAt, now),
        ),
      ),
    )
    .orderBy(sql`${schema.apiHealthLatest.checkPriority} ASC NULLS FIRST`)
    .limit(limit);

  const queue = new PriorityQueue<ProbeTarget>();

  for (const row of rows) {
    const url = row.baseUrl ?? row.docsUrl;
    if (!url) continue;

    const priority =
      row.priority ??
      computeCheckPriority({
        popularityScore: Number(row.popularity ?? 0),
        status: (row.status as HealthState['status']) ?? 'unknown',
        consecutiveFailures: row.failures ?? 0,
      });

    queue.enqueue({ apiId: row.apiId, slug: row.slug, url }, priority);
  }

  return queue.dequeueBatch(limit);
}

/** Probe one API and persist the outcome. Never throws. */
export async function probeAndRecord(handle: DatabaseHandle, target: ProbeTarget): Promise<void> {
  const config = getConfig();
  const { db } = handle;

  const result = await probe(target);
  const observed = classifyProbe(result, {
    degradedLatencyMs: config.HEALTH_DEGRADED_LATENCY_MS,
  });

  const [existing] = await db
    .select()
    .from(schema.apiHealthLatest)
    .where(eq(schema.apiHealthLatest.apiId, target.apiId))
    .limit(1);

  const current: HealthState = {
    status: (existing?.status as HealthState['status']) ?? 'unknown',
    consecutiveFailures: existing?.consecutiveFailures ?? 0,
    consecutiveSuccesses: existing?.consecutiveSuccesses ?? 0,
  };

  const next = transition(current, observed);
  const now = new Date();

  // 1. Append the raw observation (retained 30-90 days, report 31.1).
  await db.insert(schema.apiHealthChecks).values({
    id: schema.newId('healthCheck'),
    apiId: target.apiId,
    status: observed,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    responseBytes: result.responseBytes,
    checkedAt: now,
  });

  // 2. Recompute the trailing windows from stored observations, so the values
  //    are reproducible rather than incrementally drifting.
  const [uptimeRow] = await db
    .select({
      total: count(),
      successful: sql<number>`count(*) FILTER (WHERE status IN ('up','degraded'))`,
      avgLatency: sql<number | null>`avg(latency_ms)`,
    })
    .from(schema.apiHealthChecks)
    .where(
      and(
        eq(schema.apiHealthChecks.apiId, target.apiId),
        gte(schema.apiHealthChecks.checkedAt, new Date(Date.now() - 30 * 86_400_000)),
      ),
    );

  const [weekRow] = await db
    .select({
      total: count(),
      successful: sql<number>`count(*) FILTER (WHERE status IN ('up','degraded'))`,
    })
    .from(schema.apiHealthChecks)
    .where(
      and(
        eq(schema.apiHealthChecks.apiId, target.apiId),
        gte(schema.apiHealthChecks.checkedAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    );

  const uptime30d =
    uptimeRow && Number(uptimeRow.total) > 0
      ? Number(uptimeRow.successful) / Number(uptimeRow.total)
      : null;
  const successRate7d =
    weekRow && Number(weekRow.total) > 0 ? Number(weekRow.successful) / Number(weekRow.total) : null;

  const incidentCount = await db
    .select({ value: count() })
    .from(schema.incidents)
    .where(
      and(
        eq(schema.incidents.apiId, target.apiId),
        gte(schema.incidents.startedAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    );

  const reliability = computeReliability({
    uptime30d,
    successRate7d,
    avgLatencyMs: uptimeRow?.avgLatency == null ? null : Number(uptimeRow.avgLatency),
    lastCheckedAt: now,
    recentIncidents: Number(incidentCount[0]?.value ?? 0),
  });

  const nextCheckAt = new Date(
    Date.now() +
      computeNextCheckDelay(next.status, next.consecutiveFailures, config.HEALTH_SCHEDULE_INTERVAL_MS),
  );

  // 3. Upsert the hot-path row.
  await db
    .insert(schema.apiHealthLatest)
    .values({
      apiId: target.apiId,
      status: next.status,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      consecutiveFailures: next.consecutiveFailures,
      consecutiveSuccesses: next.consecutiveSuccesses,
      uptime30d,
      successRate7d,
      reliabilityScore: reliability.score,
      lastCheckedAt: now,
      nextCheckAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.apiHealthLatest.apiId,
      set: {
        status: next.status,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        consecutiveFailures: next.consecutiveFailures,
        consecutiveSuccesses: next.consecutiveSuccesses,
        uptime30d,
        successRate7d,
        reliabilityScore: reliability.score,
        lastCheckedAt: now,
        nextCheckAt,
        updatedAt: now,
      },
    });

  // 4. Incident lifecycle.
  if (next.incidentOpened) {
    const incidentId = schema.newId('incident');
    await db.insert(schema.incidents).values({
      id: incidentId,
      apiId: target.apiId,
      status: next.status,
      errorCode: result.errorCode,
      checksAffected: next.consecutiveFailures,
      startedAt: now,
    });

    log.warn({ slug: target.slug, errorCode: result.errorCode }, 'incident opened');
    events.emitAsync('health.incident_opened', {
      apiId: target.apiId,
      incidentId,
      errorCode: result.errorCode,
    });
  }

  if (next.incidentResolved) {
    const [open] = await db
      .select({ id: schema.incidents.id, startedAt: schema.incidents.startedAt })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.apiId, target.apiId), isNull(schema.incidents.resolvedAt)))
      .limit(1);

    if (open) {
      const durationMs = now.getTime() - open.startedAt.getTime();
      await db
        .update(schema.incidents)
        .set({ resolvedAt: now, durationMs })
        .where(eq(schema.incidents.id, open.id));

      log.info({ slug: target.slug, durationMs }, 'incident resolved');
      events.emitAsync('health.incident_resolved', {
        apiId: target.apiId,
        incidentId: open.id,
        durationMs,
      });
    }
  }

  if (next.changed) {
    events.emitAsync('health.checked', {
      apiId: target.apiId,
      status: next.status,
      previousStatus: current.status,
      latencyMs: result.latencyMs,
    });
  }
}

/** Probe a batch with bounded concurrency (report 23, backpressure). */
export async function runHealthSweep(
  handle: DatabaseHandle,
  lockProvider: LockProvider,
  batchSize = 50,
): Promise<{ probed: number; failed: number }> {
  const config = getConfig();

  const result = await withLock(lockProvider, 'health-sweep', 120_000, async () => {
    const targets = await selectDueTargets(handle, batchSize);
    if (targets.length === 0) return { probed: 0, failed: 0 };

    log.info({ count: targets.length }, 'probing APIs');

    const outcomes = await mapWithConcurrency(
      targets,
      config.HEALTH_PROBE_CONCURRENCY,
      (target) => probeAndRecord(handle, target),
    );

    const failed = outcomes.filter((o) => o.status === 'rejected').length;
    if (failed > 0) log.warn({ failed }, 'some probes could not be recorded');

    return { probed: targets.length, failed };
  });

  return result ?? { probed: 0, failed: 0 };
}

/**
 * Roll raw observations into daily aggregates (report 17).
 *
 * Reproducible by construction: it recomputes the day from the raw rows rather
 * than incrementing counters, so re-running it converges on the same values.
 */
export async function aggregateDaily(handle: DatabaseHandle, day?: string): Promise<number> {
  const targetDay = day ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${targetDay}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);

  const rows = await handle.query<{
    api_id: string;
    total: string;
    successful: string;
    avg_latency: string | null;
    latencies: number[] | null;
  }>(
    `SELECT api_id,
            count(*)                                              AS total,
            count(*) FILTER (WHERE status IN ('up','degraded'))   AS successful,
            avg(latency_ms)                                       AS avg_latency,
            array_agg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS latencies
       FROM api_health_checks
      WHERE checked_at >= $1 AND checked_at < $2
      GROUP BY api_id`,
    [start.toISOString(), end.toISOString()],
  );

  let written = 0;

  for (const row of rows) {
    const total = Number(row.total);
    const successful = Number(row.successful);
    const latencies = (row.latencies ?? []).map(Number).filter(Number.isFinite);

    const [incidentRow] = await handle.query<{ value: string }>(
      `SELECT count(*) AS value FROM incidents
        WHERE api_id = $1 AND started_at >= $2 AND started_at < $3`,
      [row.api_id, start.toISOString(), end.toISOString()],
    );

    await handle.db
      .insert(schema.apiHealthDaily)
      .values({
        apiId: row.api_id,
        day: targetDay,
        totalChecks: total,
        successfulChecks: successful,
        uptime: total > 0 ? successful / total : 0,
        avgLatencyMs: row.avg_latency === null ? null : Number(row.avg_latency),
        p95LatencyMs: percentile(latencies, 95),
        incidents: Number(incidentRow?.value ?? 0),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.apiHealthDaily.apiId, schema.apiHealthDaily.day],
        set: {
          totalChecks: total,
          successfulChecks: successful,
          uptime: total > 0 ? successful / total : 0,
          avgLatencyMs: row.avg_latency === null ? null : Number(row.avg_latency),
          p95LatencyMs: percentile(latencies, 95),
          incidents: Number(incidentRow?.value ?? 0),
          updatedAt: new Date(),
        },
      });

    written += 1;
  }

  log.info({ day: targetDay, apis: written }, 'daily health aggregated');
  return written;
}

/** Delete raw observations past the retention window (report 31.1). */
export async function pruneOldChecks(handle: DatabaseHandle): Promise<number> {
  const config = getConfig();
  const cutoff = new Date(Date.now() - config.HEALTH_RETENTION_DAYS * 86_400_000);

  const deleted = await handle.query<{ count: string }>(
    `WITH removed AS (DELETE FROM api_health_checks WHERE checked_at < $1 RETURNING 1)
     SELECT count(*) AS count FROM removed`,
    [cutoff.toISOString()],
  );

  const total = Number(deleted[0]?.count ?? 0);
  if (total > 0) log.info({ removed: total, cutoff }, 'pruned old health observations');
  return total;
}

/** Recompute popularity from real usage (report FR-12). */
export async function recomputePopularity(handle: DatabaseHandle): Promise<void> {
  // Blend recent views and playground runs with the ingestion-time heuristic,
  // so a genuinely used API rises above one that merely looked promising.
  await handle.execute(`
    WITH usage AS (
      SELECT api_id,
             sum(views) AS views,
             sum(playground_runs) AS runs
        FROM api_views
       WHERE day >= (CURRENT_DATE - INTERVAL '30 days')
       GROUP BY api_id
    ), ranked AS (
      SELECT api_id,
             percent_rank() OVER (ORDER BY (views + runs * 5)) AS pct
        FROM usage
    )
    UPDATE apis a
       SET popularity_score = LEAST(100, GREATEST(0, a.popularity_score * 0.6 + r.pct * 100 * 0.4))
      FROM ranked r
     WHERE a.id = r.api_id
  `);

  log.info('popularity scores recomputed');
}
