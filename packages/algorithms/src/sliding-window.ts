/**
 * Sliding-window rate limiting (report 18.1) plus a small rolling-metrics
 * window used by the circuit breaker and the health classifier.
 *
 * Two variants are provided because they trade memory against precision:
 *
 *  1. SlidingWindowCounter - approximate, O(1) memory per subject.
 *     Interpolates between the previous and current fixed window. This is what
 *     production uses: fixed windows allow a 2x burst at the boundary, and this
 *     removes that without storing per-request timestamps.
 *
 *  2. SlidingWindowLog - exact, O(limit) memory per subject.
 *     Keeps a timestamp per request in a ring buffer. Reserved for low-volume,
 *     high-value routes (admin, auth) where exactness is worth the memory.
 */

export interface WindowDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** Current (possibly interpolated) usage count. */
  used: number;
}

interface CounterState {
  /** Index of the window `currentCount` belongs to. */
  windowIndex: number;
  currentCount: number;
  previousCount: number;
}

/**
 * Approximate sliding window.
 *
 * weighted = previousCount * (1 - elapsedFraction) + currentCount
 *
 * Example: limit 100/min, 90 requests in the previous minute, 20 so far in the
 * current minute, 25% of the way through it:
 *   weighted = 90 * 0.75 + 20 = 87.5  -> still allowed, and the previous
 *   window's influence decays smoothly instead of vanishing at the boundary.
 */
export class SlidingWindowCounter {
  private readonly states = new Map<string, CounterState>();
  private readonly now: () => number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    now?: () => number,
  ) {
    if (limit <= 0) throw new RangeError('limit must be > 0');
    if (windowMs <= 0) throw new RangeError('windowMs must be > 0');
    this.now = now ?? Date.now;
  }

  hit(key: string, cost = 1): WindowDecision {
    const now = this.now();
    const windowIndex = Math.floor(now / this.windowMs);
    const elapsedFraction = (now % this.windowMs) / this.windowMs;

    let state = this.states.get(key);
    if (!state) {
      state = { windowIndex, currentCount: 0, previousCount: 0 };
      this.states.set(key, state);
    }

    // Roll the window forward. A gap of 2+ windows means the history is stale.
    if (state.windowIndex !== windowIndex) {
      const gap = windowIndex - state.windowIndex;
      state.previousCount = gap === 1 ? state.currentCount : 0;
      state.currentCount = 0;
      state.windowIndex = windowIndex;
    }

    const weighted = state.previousCount * (1 - elapsedFraction) + state.currentCount;

    if (weighted + cost > this.limit) {
      // How long until enough of the previous window decays away.
      const overflow = weighted + cost - this.limit;
      const retryAfterMs =
        state.previousCount > 0
          ? Math.ceil((overflow / state.previousCount) * this.windowMs)
          : Math.ceil(this.windowMs * (1 - elapsedFraction));

      return {
        allowed: false,
        remaining: Math.max(0, Math.floor(this.limit - weighted)),
        retryAfterMs: Math.max(1, Math.min(retryAfterMs, this.windowMs)),
        used: weighted,
      };
    }

    state.currentCount += cost;
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(this.limit - weighted - cost)),
      retryAfterMs: 0,
      used: weighted + cost,
    };
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  /** Drop subjects whose windows are entirely in the past. */
  prune(): number {
    const currentIndex = Math.floor(this.now() / this.windowMs);
    let removed = 0;
    for (const [key, state] of this.states) {
      if (currentIndex - state.windowIndex > 1) {
        this.states.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.states.size;
  }
}

/**
 * Exact sliding window using a fixed-size ring buffer of timestamps.
 * Memory is O(limit) per subject and never grows beyond it.
 */
export class SlidingWindowLog {
  private readonly logs = new Map<string, { buffer: Float64Array; head: number; count: number }>();
  private readonly now: () => number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    now?: () => number,
  ) {
    if (limit <= 0) throw new RangeError('limit must be > 0');
    this.now = now ?? Date.now;
  }

  hit(key: string): WindowDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;

    let entry = this.logs.get(key);
    if (!entry) {
      entry = { buffer: new Float64Array(this.limit), head: 0, count: 0 };
      this.logs.set(key, entry);
    }

    // Evict from the tail while the oldest entry has fallen out of the window.
    while (entry.count > 0) {
      const tailIndex = (entry.head - entry.count + this.limit) % this.limit;
      if ((entry.buffer[tailIndex] as number) > cutoff) break;
      entry.count -= 1;
    }

    if (entry.count >= this.limit) {
      const oldestIndex = (entry.head - entry.count + this.limit) % this.limit;
      const oldest = entry.buffer[oldestIndex] as number;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, Math.ceil(oldest + this.windowMs - now)),
        used: entry.count,
      };
    }

    entry.buffer[entry.head] = now;
    entry.head = (entry.head + 1) % this.limit;
    entry.count += 1;

    return {
      allowed: true,
      remaining: this.limit - entry.count,
      retryAfterMs: 0,
      used: entry.count,
    };
  }

  reset(key: string): void {
    this.logs.delete(key);
  }

  get size(): number {
    return this.logs.size;
  }
}

/**
 * Rolling window of boolean outcomes, bucketed by time.
 *
 * The circuit breaker (report 22/23) asks "what fraction of recent calls
 * failed?". Storing every outcome is wasteful, so outcomes are aggregated into
 * `bucketCount` time buckets that rotate as time advances.
 */
export class RollingOutcomeWindow {
  private readonly successes: Uint32Array;
  private readonly failures: Uint32Array;
  private readonly bucketMs: number;
  private lastBucketIndex = -1;
  private readonly now: () => number;

  constructor(windowMs: number, bucketCount = 10, now?: () => number) {
    if (bucketCount <= 0) throw new RangeError('bucketCount must be > 0');
    this.successes = new Uint32Array(bucketCount);
    this.failures = new Uint32Array(bucketCount);
    this.bucketMs = Math.max(1, Math.floor(windowMs / bucketCount));
    this.now = now ?? Date.now;
  }

  private rotate(): number {
    const index = Math.floor(this.now() / this.bucketMs);
    const slot = index % this.successes.length;

    if (this.lastBucketIndex !== index) {
      const elapsed = this.lastBucketIndex === -1 ? this.successes.length : index - this.lastBucketIndex;
      // Clear every bucket we skipped over, capped at a full rotation.
      const toClear = Math.min(elapsed, this.successes.length);
      for (let i = 0; i < toClear; i += 1) {
        const clearSlot = (slot - i + this.successes.length) % this.successes.length;
        this.successes[clearSlot] = 0;
        this.failures[clearSlot] = 0;
      }
      this.lastBucketIndex = index;
    }
    return slot;
  }

  record(success: boolean): void {
    const slot = this.rotate();
    if (success) this.successes[slot] = (this.successes[slot] as number) + 1;
    else this.failures[slot] = (this.failures[slot] as number) + 1;
  }

  snapshot(): { successes: number; failures: number; total: number; failureRate: number } {
    this.rotate();
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < this.successes.length; i += 1) {
      successes += this.successes[i] as number;
      failures += this.failures[i] as number;
    }
    const total = successes + failures;
    return { successes, failures, total, failureRate: total === 0 ? 0 : failures / total };
  }

  reset(): void {
    this.successes.fill(0);
    this.failures.fill(0);
    this.lastBucketIndex = -1;
  }
}
