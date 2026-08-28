/**
 * Health classification and reliability scoring (report 17.1, 17.2).
 *
 * Pure functions with no I/O, so the state machine and the scoring model can
 * be exhaustively unit-tested — which report 28.1 lists as a minimum coverage
 * priority ("health state transitions").
 */
import { RELIABILITY_WEIGHTS, LATENCY_SCORE_CEILING_MS } from '@apihub/config';
import type { HealthStatus } from '@apihub/contracts';

/** Raw outcome of a single probe. */
export interface ProbeResult {
  httpStatus: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  responseBytes: number | null;
}

export interface ClassifyOptions {
  /** Latency above which a successful response is still counted as degraded. */
  degradedLatencyMs: number;
}

/**
 * Classify one probe.
 *
 * Notes on the choices here:
 *  - 401/403 mean the endpoint is UP; we simply lack a credential. Marking a
 *    working API as down because it requires a key would be wrong, and most of
 *    the catalogue requires keys.
 *  - 429 means the API is alive and rate limiting us. That is degraded, not down.
 *  - 5xx is the upstream failing: down.
 *  - A slow but successful response is degraded, per the state machine.
 */
export function classifyProbe(result: ProbeResult, options: ClassifyOptions): HealthStatus {
  if (result.errorCode !== null) {
    // Network-level failures are unambiguous.
    return 'down';
  }

  const status = result.httpStatus;
  if (status === null) return 'down';

  if (status >= 500) return 'down';
  if (status === 429) return 'degraded';

  // 2xx, 3xx and most 4xx indicate a reachable, responding service.
  if (status >= 200 && status < 500) {
    if (result.latencyMs !== null && result.latencyMs > options.degradedLatencyMs) {
      return 'degraded';
    }
    return 'up';
  }

  return 'down';
}

/** Whether a probe counts as a success for uptime purposes. */
export function isSuccessful(status: HealthStatus): boolean {
  return status === 'up' || status === 'degraded';
}

export interface HealthState {
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export interface TransitionResult extends HealthState {
  /** True when the public status actually changed. */
  changed: boolean;
  /** True when this transition opens an incident. */
  incidentOpened: boolean;
  /** True when this transition closes an open incident. */
  incidentResolved: boolean;
}

/**
 * Number of consecutive failures before an API is publicly marked down.
 *
 * A single failed probe is frequently a transient network blip on OUR side, and
 * flapping a public status board is worse than being slightly slow to report.
 */
export const FAILURE_THRESHOLD = 2;

/** Consecutive successes required to declare a recovery. */
export const RECOVERY_THRESHOLD = 1;

/**
 * Apply one observation to the state machine (report 17.1).
 *
 *   UNKNOWN -> UP | DOWN
 *   UP      -> DEGRADED | DOWN
 *   DEGRADED-> UP | DOWN
 *   DOWN    -> UP
 */
export function transition(current: HealthState, observed: HealthStatus): TransitionResult {
  const previous = current.status;

  if (isSuccessful(observed)) {
    const consecutiveSuccesses = current.consecutiveSuccesses + 1;

    // Recovering from down requires meeting the recovery threshold; below it,
    // the API stays down so a single lucky probe cannot clear an outage.
    if (previous === 'down' && consecutiveSuccesses < RECOVERY_THRESHOLD) {
      return {
        status: 'down',
        consecutiveFailures: current.consecutiveFailures,
        consecutiveSuccesses,
        changed: false,
        incidentOpened: false,
        incidentResolved: false,
      };
    }

    return {
      status: observed,
      consecutiveFailures: 0,
      consecutiveSuccesses,
      changed: previous !== observed,
      incidentOpened: false,
      incidentResolved: previous === 'down',
    };
  }

  const consecutiveFailures = current.consecutiveFailures + 1;

  // Below the threshold the API keeps its previous public status, but the
  // failure is still counted and persisted.
  if (consecutiveFailures < FAILURE_THRESHOLD && previous !== 'unknown') {
    return {
      status: previous === 'up' ? 'degraded' : previous,
      consecutiveFailures,
      consecutiveSuccesses: 0,
      changed: previous === 'up',
      incidentOpened: false,
      incidentResolved: false,
    };
  }

  return {
    status: 'down',
    consecutiveFailures,
    consecutiveSuccesses: 0,
    changed: previous !== 'down',
    incidentOpened: previous !== 'down',
    incidentResolved: false,
  };
}

// ── Reliability score (report 17.2) ───────────────────────────

export interface ReliabilityInputs {
  uptime30d: number | null;
  successRate7d: number | null;
  avgLatencyMs: number | null;
  lastCheckedAt: Date | null;
  recentIncidents: number;
  now?: number;
}

export interface ReliabilityBreakdown {
  score: number;
  uptime30d: number | null;
  successRate7d: number | null;
  latencyScore: number | null;
  freshness: number;
  incidentPenalty: number;
}

function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Freshness of the measurement itself.
 *
 * A perfect uptime record from three weeks ago should not be presented with
 * the same confidence as one from ten minutes ago. Decays to ~0 over 24 hours.
 */
export function measurementFreshness(lastCheckedAt: Date | null, now: number): number {
  if (!lastCheckedAt) return 0;
  const ageHours = (now - lastCheckedAt.getTime()) / 3_600_000;
  if (ageHours <= 1) return 1;
  return unit(1 - ageHours / 24);
}

/**
 * Composite reliability, 0..100:
 *
 *   0.50*uptime_30d + 0.20*success_rate_7d + 0.15*latency_score
 * + 0.10*freshness  + 0.05*(1 - incident_penalty)
 */
export function computeReliability(inputs: ReliabilityInputs): ReliabilityBreakdown {
  const now = inputs.now ?? Date.now();
  const weights = RELIABILITY_WEIGHTS;

  const uptime = inputs.uptime30d;
  const successRate = inputs.successRate7d;

  const latencyScore =
    inputs.avgLatencyMs === null ? null : unit(1 - inputs.avgLatencyMs / LATENCY_SCORE_CEILING_MS);

  const freshness = measurementFreshness(inputs.lastCheckedAt, now);

  // Each recent incident costs 20% of the incident component, floored at zero.
  const incidentPenalty = unit(inputs.recentIncidents * 0.2);

  // Unmeasured dimensions are treated as neutral (0.5) rather than zero, so a
  // newly-added API is not ranked below one with a known bad record.
  const score =
    weights.uptime30d * (uptime ?? 0.5) +
    weights.successRate7d * (successRate ?? 0.5) +
    weights.latency * (latencyScore ?? 0.5) +
    weights.freshness * freshness +
    weights.incidentPenalty * (1 - incidentPenalty);

  return {
    score: Math.round(unit(score) * 1000) / 10,
    uptime30d: uptime,
    successRate7d: successRate,
    latencyScore,
    freshness,
    incidentPenalty,
  };
}

/**
 * Probe scheduling priority: lower runs sooner.
 *
 * Feeds the priority queue in the worker (report 21). The intent is that a
 * popular API that just started failing is re-checked before an obscure one
 * that has been stable for weeks.
 */
export function computeCheckPriority(input: {
  popularityScore: number;
  status: HealthStatus;
  consecutiveFailures: number;
}): number {
  let priority = 100 - Math.round(input.popularityScore / 2); // 50..100

  // Something actively broken deserves attention soonest.
  if (input.status === 'down') priority -= 40;
  else if (input.status === 'degraded') priority -= 25;
  else if (input.status === 'unknown') priority -= 15;

  // A newly-failing API is more interesting than a long-dead one.
  if (input.consecutiveFailures > 0 && input.consecutiveFailures <= 3) priority -= 10;

  return Math.max(1, priority);
}

/**
 * Interval until the next probe.
 *
 * Failing APIs are re-checked more often (to catch recovery quickly), and
 * long-dead ones progressively less often (to stop wasting probe capacity on
 * something that has been gone for a week).
 */
export function computeNextCheckDelay(
  status: HealthStatus,
  consecutiveFailures: number,
  baseIntervalMs: number,
): number {
  switch (status) {
    case 'down': {
      // Back off after sustained failure, capped at 8x the base interval.
      const multiplier = Math.min(8, Math.pow(1.5, Math.max(0, consecutiveFailures - 2)));
      return Math.round(baseIntervalMs * multiplier);
    }
    case 'degraded':
      return Math.round(baseIntervalMs * 0.75);
    case 'unknown':
      return Math.round(baseIntervalMs * 0.5);
    case 'up':
    default:
      return baseIntervalMs;
  }
}

/** Exact p-quantile from a sample array. Used for daily p95 latency. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}
