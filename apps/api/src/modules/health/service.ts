/**
 * Health application service (report 17).
 *
 * Read-side only. Writing probe results is the worker's job (apps/worker);
 * this assembles the reports the API serves.
 */
import { CACHE_KEYS, CACHE_TTL } from '@apihub/config';
import type { HealthBoard, HealthReport } from '@apihub/contracts';
import type { CacheService } from '@apihub/runtime';

import { NotFoundError } from '../../shared/errors.js';
import type { HealthRepository } from './repository.js';
import { computeReliability } from './scoring.js';

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly cache: CacheService,
  ) {}

  async report(apiId: string, days: number): Promise<HealthReport> {
    return this.cache.getOrSet(
      `${CACHE_KEYS.healthSummary(apiId)}:${days}`,
      async () => {
        const latest = await this.repository.latestFor(apiId);
        if (!latest) {
          // A never-probed API is a valid state, not an error: return an
          // "unknown" report rather than 404, so the UI renders consistently.
          return this.emptyReport(apiId);
        }

        const [history, recentChecks, incidents, incidentCount] = await Promise.all([
          this.repository.dailyHistory(apiId, days),
          this.repository.recentChecks(apiId, 30),
          this.repository.incidentsFor(apiId, 10),
          this.repository.recentIncidentCount(apiId, 7),
        ]);

        const reliability = computeReliability({
          uptime30d: latest.uptime30d === null ? null : Number(latest.uptime30d),
          successRate7d: latest.successRate7d === null ? null : Number(latest.successRate7d),
          avgLatencyMs: latest.latencyMs === null ? null : Number(latest.latencyMs),
          lastCheckedAt: latest.lastCheckedAt,
          recentIncidents: incidentCount,
        });

        return {
          apiId,
          current: {
            status: latest.status as HealthReport['current']['status'],
            latencyMs: latest.latencyMs,
            httpStatus: latest.httpStatus,
            lastCheckedAt: latest.lastCheckedAt?.toISOString() ?? null,
            consecutiveFailures: latest.consecutiveFailures,
          },
          reliability,
          history,
          // Reverse so the sparkline reads left-to-right, oldest to newest.
          recentChecks: [...recentChecks].reverse(),
          incidents,
        };
      },
      { ttlSeconds: CACHE_TTL.healthSummary },
    );
  }

  async board(limit: number, status?: string): Promise<HealthBoard> {
    return this.cache.getOrSet(
      `health:board:${limit}:${status ?? 'all'}`,
      async () => {
        const [entries, summary] = await Promise.all([
          this.repository.board(limit, status),
          this.repository.summary(),
        ]);
        return { entries, summary };
      },
      { ttlSeconds: CACHE_TTL.healthLatest },
    );
  }

  async openIncidents(limit = 20) {
    return this.repository.openIncidents(limit);
  }

  /** Assert that an API has been monitored; used by routes that require it. */
  async requireMonitored(apiId: string): Promise<void> {
    const latest = await this.repository.latestFor(apiId);
    if (!latest) throw new NotFoundError('Health data');
  }

  private emptyReport(apiId: string): HealthReport {
    return {
      apiId,
      current: {
        status: 'unknown',
        latencyMs: null,
        httpStatus: null,
        lastCheckedAt: null,
        consecutiveFailures: 0,
      },
      reliability: {
        score: 0,
        uptime30d: null,
        successRate7d: null,
        latencyScore: null,
        freshness: 0,
        incidentPenalty: 0,
      },
      history: [],
      recentChecks: [],
      incidents: [],
    };
  }
}
