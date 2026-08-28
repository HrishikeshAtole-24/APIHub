/**
 * Health repository (report 17, 13.3).
 *
 * Reads come from the precomputed `api_health_latest` and `api_health_daily`
 * tables wherever possible; raw probe rows are only touched for the recent
 * sparkline and for the aggregation job.
 */
import type { HealthBoardEntry, HealthCheck, HealthDaily, Incident } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { and, asc, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';

/**
 * Normalise a raw `db.execute` result across drivers: node-postgres and PGlite
 * return `{ rows }`, the Neon HTTP driver returns a bare array.
 */
function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

const { apis, apiHealthChecks, apiHealthDaily, apiHealthLatest, incidents } = schema;

export class HealthRepository {
  constructor(private readonly db: Database) {}

  async latestFor(apiId: string): Promise<typeof apiHealthLatest.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(apiHealthLatest)
      .where(eq(apiHealthLatest.apiId, apiId))
      .limit(1);
    return row ?? null;
  }

  /** Most recent raw probes, newest first, for the latency sparkline. */
  async recentChecks(apiId: string, limit = 30): Promise<HealthCheck[]> {
    const rows = await this.db
      .select()
      .from(apiHealthChecks)
      .where(eq(apiHealthChecks.apiId, apiId))
      .orderBy(desc(apiHealthChecks.checkedAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      apiId: row.apiId,
      status: row.status as HealthCheck['status'],
      httpStatus: row.httpStatus,
      latencyMs: row.latencyMs,
      errorCode: row.errorCode,
      checkedAt: row.checkedAt.toISOString(),
    }));
  }

  /** Daily aggregates for the uptime bar chart, oldest first. */
  async dailyHistory(apiId: string, days: number): Promise<HealthDaily[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    const rows = await this.db
      .select()
      .from(apiHealthDaily)
      .where(and(eq(apiHealthDaily.apiId, apiId), gte(apiHealthDaily.day, since)))
      .orderBy(asc(apiHealthDaily.day));

    return rows.map((row) => ({
      date: String(row.day),
      totalChecks: row.totalChecks,
      successfulChecks: row.successfulChecks,
      uptime: Number(row.uptime),
      avgLatencyMs: row.avgLatencyMs === null ? null : Number(row.avgLatencyMs),
      p95LatencyMs: row.p95LatencyMs === null ? null : Number(row.p95LatencyMs),
      incidents: row.incidents,
    }));
  }

  async incidentsFor(apiId: string, limit = 10): Promise<Incident[]> {
    const rows = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.apiId, apiId))
      .orderBy(desc(incidents.startedAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      apiId: row.apiId,
      status: row.status as Incident['status'],
      startedAt: row.startedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      checksAffected: row.checksAffected,
    }));
  }

  /** Count of incidents opened in the trailing window; feeds the score penalty. */
  async recentIncidentCount(apiId: string, days = 7): Promise<number> {
    const since = new Date(Date.now() - days * 86_400_000);
    const [row] = await this.db
      .select({ value: count() })
      .from(incidents)
      .where(and(eq(incidents.apiId, apiId), gte(incidents.startedAt, since)));
    return Number(row?.value ?? 0);
  }

  /**
   * Status board for the monitoring dashboard.
   *
   * Sparklines are fetched for the whole page in ONE query using a window
   * function, rather than one query per API (report 33.1: avoid N+1).
   */
  async board(limit = 100, status?: string): Promise<HealthBoardEntry[]> {
    const rows = await this.db
      .select({
        apiId: apis.id,
        slug: apis.slug,
        name: apis.name,
        status: apiHealthLatest.status,
        latencyMs: apiHealthLatest.latencyMs,
        uptime30d: apiHealthLatest.uptime30d,
        reliabilityScore: apiHealthLatest.reliabilityScore,
        lastCheckedAt: apiHealthLatest.lastCheckedAt,
      })
      .from(apiHealthLatest)
      .innerJoin(apis, eq(apis.id, apiHealthLatest.apiId))
      .where(
        status
          ? and(eq(apis.status, 'active'), eq(apiHealthLatest.status, status))
          : eq(apis.status, 'active'),
      )
      .orderBy(
        // Broken things first: this is a dashboard, not a catalogue.
        sql`CASE ${apiHealthLatest.status}
              WHEN 'down' THEN 0
              WHEN 'degraded' THEN 1
              WHEN 'unknown' THEN 2
              ELSE 3 END`,
        desc(apis.popularityScore),
      )
      .limit(limit);

    if (rows.length === 0) return [];

    const sparklines = await this.sparklinesFor(rows.map((row) => row.apiId));

    return rows.map((row) => ({
      apiId: row.apiId,
      slug: row.slug,
      name: row.name,
      status: row.status as HealthBoardEntry['status'],
      latencyMs: row.latencyMs,
      uptime30d: row.uptime30d === null ? null : Number(row.uptime30d),
      reliabilityScore: row.reliabilityScore === null ? null : Number(row.reliabilityScore),
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      sparkline: sparklines.get(row.apiId) ?? [],
    }));
  }

  /**
   * Latest N latencies per API, in one query.
   *
   * ROW_NUMBER() partitioned by api_id gives the per-API "top N" without a
   * lateral join or a query per row.
   */
  private async sparklinesFor(apiIds: string[], points = 20): Promise<Map<string, number[]>> {
    if (apiIds.length === 0) return new Map();

    // Raw SQL: a window function inside a derived table is clearer here than
    // the query-builder equivalent, and the report explicitly warns against
    // hiding useful SQL behind an abstraction (report 11.1).
    const result = await this.db.execute(sql`
      SELECT api_id, latency_ms
        FROM (
          SELECT api_id,
                 latency_ms,
                 checked_at,
                 row_number() OVER (PARTITION BY api_id ORDER BY checked_at DESC) AS rn
            FROM api_health_checks
           WHERE api_id IN (${sql.join(apiIds.map((id) => sql`${id}`), sql`, `)})
        ) ranked
       WHERE rn <= ${points}
       ORDER BY api_id, checked_at ASC
    `);

    const map = new Map<string, number[]>();
    for (const row of normalizeRows<{ api_id: string; latency_ms: number | null }>(result)) {
      if (row.latency_ms === null) continue;
      const series = map.get(row.api_id) ?? [];
      series.push(Number(row.latency_ms));
      map.set(row.api_id, series);
    }
    return map;
  }

  /** Aggregate counts for the dashboard summary strip. */
  async summary(): Promise<{
    total: number;
    up: number;
    degraded: number;
    down: number;
    unknown: number;
    avgLatencyMs: number | null;
    overallUptime: number | null;
  }> {
    const [row] = await this.db
      .select({
        total: count(),
        up: sql<number>`count(*) FILTER (WHERE ${apiHealthLatest.status} = 'up')`,
        degraded: sql<number>`count(*) FILTER (WHERE ${apiHealthLatest.status} = 'degraded')`,
        down: sql<number>`count(*) FILTER (WHERE ${apiHealthLatest.status} = 'down')`,
        unknown: sql<number>`count(*) FILTER (WHERE ${apiHealthLatest.status} = 'unknown')`,
        avgLatency: sql<number | null>`avg(${apiHealthLatest.latencyMs})`,
        avgUptime: sql<number | null>`avg(${apiHealthLatest.uptime30d})`,
      })
      .from(apiHealthLatest);

    return {
      total: Number(row?.total ?? 0),
      up: Number(row?.up ?? 0),
      degraded: Number(row?.degraded ?? 0),
      down: Number(row?.down ?? 0),
      unknown: Number(row?.unknown ?? 0),
      avgLatencyMs: row?.avgLatency == null ? null : Math.round(Number(row.avgLatency)),
      overallUptime: row?.avgUptime == null ? null : Number(row.avgUptime),
    };
  }

  /** Currently-open incidents across the platform. */
  async openIncidents(limit = 20): Promise<(Incident & { apiName: string; apiSlug: string })[]> {
    const rows = await this.db
      .select({
        incident: incidents,
        apiName: apis.name,
        apiSlug: apis.slug,
      })
      .from(incidents)
      .innerJoin(apis, eq(apis.id, incidents.apiId))
      .where(isNull(incidents.resolvedAt))
      .orderBy(desc(incidents.startedAt))
      .limit(limit);

    return rows.map(({ incident, apiName, apiSlug }) => ({
      id: incident.id,
      apiId: incident.apiId,
      status: incident.status as Incident['status'],
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: null,
      durationMs: null,
      errorCode: incident.errorCode,
      checksAffected: incident.checksAffected,
      apiName,
      apiSlug,
    }));
  }
}
