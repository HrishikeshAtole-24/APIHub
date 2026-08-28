/**
 * Health state machine and scoring tests.
 *
 * Report 28.1 lists "health state transitions" as a minimum coverage priority,
 * and for good reason: this logic decides what a public status board says about
 * someone else's service. Getting it wrong is either a false outage or a missed
 * one.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyProbe,
  computeCheckPriority,
  computeNextCheckDelay,
  computeReliability,
  FAILURE_THRESHOLD,
  isSuccessful,
  measurementFreshness,
  percentile,
  transition,
  type HealthState,
} from './health-scoring.js';

const options = { degradedLatencyMs: 1500 };

const probe = (over: Partial<Parameters<typeof classifyProbe>[0]> = {}) => ({
  httpStatus: 200,
  latencyMs: 100,
  errorCode: null,
  responseBytes: 500,
  ...over,
});

describe('classifyProbe', () => {
  it('treats a fast 2xx as up', () => {
    expect(classifyProbe(probe(), options)).toBe('up');
  });

  it('treats 401 and 403 as up, not down', () => {
    // The endpoint works; we simply have no credential. Most of the catalogue
    // requires a key, so marking these down would be plainly wrong.
    expect(classifyProbe(probe({ httpStatus: 401 }), options)).toBe('up');
    expect(classifyProbe(probe({ httpStatus: 403 }), options)).toBe('up');
  });

  it('treats 404 as up: the server answered', () => {
    expect(classifyProbe(probe({ httpStatus: 404 }), options)).toBe('up');
  });

  it('treats 429 as degraded, not down', () => {
    expect(classifyProbe(probe({ httpStatus: 429 }), options)).toBe('degraded');
  });

  it('treats 5xx as down', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyProbe(probe({ httpStatus: status }), options)).toBe('down');
    }
  });

  it('treats a transport error as down regardless of status', () => {
    expect(classifyProbe(probe({ errorCode: 'DNS_FAILURE', httpStatus: null }), options)).toBe(
      'down',
    );
    expect(classifyProbe(probe({ errorCode: 'TIMEOUT' }), options)).toBe('down');
  });

  it('treats a slow success as degraded', () => {
    expect(classifyProbe(probe({ latencyMs: 2500 }), options)).toBe('degraded');
    expect(classifyProbe(probe({ latencyMs: 1499 }), options)).toBe('up');
  });

  it('classifies a missing status as down', () => {
    expect(classifyProbe(probe({ httpStatus: null }), options)).toBe('down');
  });
});

describe('isSuccessful', () => {
  it('counts up and degraded toward uptime', () => {
    expect(isSuccessful('up')).toBe(true);
    expect(isSuccessful('degraded')).toBe(true);
    expect(isSuccessful('down')).toBe(false);
    expect(isSuccessful('unknown')).toBe(false);
  });
});

describe('transition', () => {
  const state = (over: Partial<HealthState> = {}): HealthState => ({
    status: 'up',
    consecutiveFailures: 0,
    consecutiveSuccesses: 5,
    ...over,
  });

  it('moves unknown to up on first success', () => {
    const result = transition(state({ status: 'unknown', consecutiveSuccesses: 0 }), 'up');
    expect(result.status).toBe('up');
    expect(result.changed).toBe(true);
  });

  it('does not flip to down on a single failure', () => {
    // One failed probe is usually a blip on OUR side. Flapping a public board
    // is worse than reporting a real outage one cycle late.
    const result = transition(state(), 'down');
    expect(result.status).toBe('degraded');
    expect(result.consecutiveFailures).toBe(1);
    expect(result.incidentOpened).toBe(false);
  });

  it('flips to down once the failure threshold is met', () => {
    let current = state();
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      const next = transition(current, 'down');
      current = {
        status: next.status,
        consecutiveFailures: next.consecutiveFailures,
        consecutiveSuccesses: next.consecutiveSuccesses,
      };
    }
    expect(current.status).toBe('down');
  });

  it('opens an incident exactly once when entering down', () => {
    const first = transition(state({ consecutiveFailures: 1 }), 'down');
    expect(first.status).toBe('down');
    expect(first.incidentOpened).toBe(true);

    const second = transition(
      { status: 'down', consecutiveFailures: 2, consecutiveSuccesses: 0 },
      'down',
    );
    // Already down: no second incident for the same outage.
    expect(second.incidentOpened).toBe(false);
  });

  it('resolves an incident on recovery', () => {
    const result = transition(
      { status: 'down', consecutiveFailures: 5, consecutiveSuccesses: 0 },
      'up',
    );
    expect(result.status).toBe('up');
    expect(result.incidentResolved).toBe(true);
    expect(result.consecutiveFailures).toBe(0);
  });

  it('does not resolve an incident that never opened', () => {
    const result = transition(state({ status: 'degraded' }), 'up');
    expect(result.incidentResolved).toBe(false);
  });

  it('reports changed only when the public status actually moves', () => {
    expect(transition(state(), 'up').changed).toBe(false);
    expect(transition(state(), 'degraded').changed).toBe(true);
  });

  it('resets the failure counter on any success', () => {
    const result = transition(state({ consecutiveFailures: 3 }), 'up');
    expect(result.consecutiveFailures).toBe(0);
  });
});

describe('computeReliability', () => {
  const base = {
    uptime30d: 1,
    successRate7d: 1,
    avgLatencyMs: 100,
    lastCheckedAt: new Date(),
    recentIncidents: 0,
  };

  it('scores a perfect record near 100', () => {
    expect(computeReliability(base).score).toBeGreaterThan(93);
  });

  it('scores a fully failing record near zero', () => {
    const result = computeReliability({
      ...base,
      uptime30d: 0,
      successRate7d: 0,
      avgLatencyMs: 5000,
      recentIncidents: 5,
    });
    expect(result.score).toBeLessThan(15);
  });

  it('treats an unmeasured API as neutral, not bad', () => {
    // A newly-added API must not rank below one with a known bad record.
    const unmeasured = computeReliability({
      uptime30d: null,
      successRate7d: null,
      avgLatencyMs: null,
      lastCheckedAt: null,
      recentIncidents: 0,
    });
    const bad = computeReliability({ ...base, uptime30d: 0, successRate7d: 0 });

    expect(unmeasured.score).toBeGreaterThan(bad.score);
  });

  it('penalises recent incidents', () => {
    const clean = computeReliability(base);
    const troubled = computeReliability({ ...base, recentIncidents: 3 });
    expect(troubled.score).toBeLessThan(clean.score);
  });

  it('penalises stale measurements', () => {
    const fresh = computeReliability(base);
    const stale = computeReliability({
      ...base,
      lastCheckedAt: new Date(Date.now() - 48 * 3_600_000),
    });
    expect(stale.score).toBeLessThan(fresh.score);
  });

  it('returns the component breakdown for display', () => {
    const result = computeReliability(base);
    expect(result.uptime30d).toBe(1);
    expect(result.latencyScore).toBeGreaterThan(0.9);
    expect(result.freshness).toBe(1);
  });

  it('clamps the score to 0..100', () => {
    const result = computeReliability({ ...base, avgLatencyMs: 100_000 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe('measurementFreshness', () => {
  it('is 1 for a recent check and 0 for a never-checked API', () => {
    expect(measurementFreshness(new Date(), Date.now())).toBe(1);
    expect(measurementFreshness(null, Date.now())).toBe(0);
  });

  it('decays over 24 hours', () => {
    const now = Date.now();
    const twelveHours = measurementFreshness(new Date(now - 12 * 3_600_000), now);
    expect(twelveHours).toBeGreaterThan(0);
    expect(twelveHours).toBeLessThan(1);
    expect(measurementFreshness(new Date(now - 30 * 3_600_000), now)).toBe(0);
  });
});

describe('computeCheckPriority', () => {
  it('gives a failing API a lower number, so it runs sooner', () => {
    const failing = computeCheckPriority({
      popularityScore: 50,
      status: 'down',
      consecutiveFailures: 1,
    });
    const healthy = computeCheckPriority({
      popularityScore: 50,
      status: 'up',
      consecutiveFailures: 0,
    });
    expect(failing).toBeLessThan(healthy);
  });

  it('prioritises popular APIs', () => {
    const popular = computeCheckPriority({ popularityScore: 100, status: 'up', consecutiveFailures: 0 });
    const obscure = computeCheckPriority({ popularityScore: 0, status: 'up', consecutiveFailures: 0 });
    expect(popular).toBeLessThan(obscure);
  });

  it('never returns a non-positive priority', () => {
    const value = computeCheckPriority({
      popularityScore: 100,
      status: 'down',
      consecutiveFailures: 2,
    });
    expect(value).toBeGreaterThanOrEqual(1);
  });
});

describe('computeNextCheckDelay', () => {
  const base = 300_000;

  it('checks a healthy API on the base interval', () => {
    expect(computeNextCheckDelay('up', 0, base)).toBe(base);
  });

  it('checks a degraded API sooner', () => {
    expect(computeNextCheckDelay('degraded', 1, base)).toBeLessThan(base);
  });

  it('backs off progressively for a sustained outage', () => {
    const early = computeNextCheckDelay('down', 2, base);
    const later = computeNextCheckDelay('down', 8, base);
    expect(later).toBeGreaterThan(early);
  });

  it('caps the backoff at 8x the base interval', () => {
    expect(computeNextCheckDelay('down', 100, base)).toBeLessThanOrEqual(base * 8);
  });
});

describe('percentile', () => {
  it('computes p95 over a sample', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
  });

  it('returns null for an empty sample', () => {
    expect(percentile([], 95)).toBeNull();
  });

  it('handles a single value', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('does not mutate the input', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});
