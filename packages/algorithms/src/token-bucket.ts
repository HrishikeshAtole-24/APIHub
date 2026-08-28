/**
 * Token bucket rate limiting (report 18.1: "Token bucket: preferred for
 * burst-tolerant APIs").
 *
 * Model
 * -----
 * A bucket holds up to `capacity` tokens and refills continuously at
 * `refillPerSecond`. Each request removes one token; when the bucket is empty
 * the request is denied and the caller is told when to retry.
 *
 * Refill is computed lazily from elapsed time rather than driven by a timer, so
 * there is no background work and state is a single small record. That is what
 * makes it cheap to hold per-subject state in Redis.
 *
 * This class is the pure, testable policy. The Redis-backed distributed
 * implementation in the API applies the same maths inside a Lua script so the
 * read-modify-write is atomic across instances.
 */

export interface TokenBucketState {
  /** Tokens available at `updatedAt`. Fractional by design. */
  tokens: number;
  /** Epoch milliseconds of the last update. */
  updatedAt: number;
}

export interface TokenBucketOptions {
  /** Maximum tokens, i.e. the largest burst permitted. */
  capacity: number;
  /** Sustained refill rate. */
  refillPerSecond: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after the decision. */
  remaining: number;
  /** Milliseconds until the next token is available. 0 when allowed. */
  retryAfterMs: number;
  /** Epoch ms at which the bucket returns to full. Useful for the Reset header. */
  resetAt: number;
}

/** Advance a bucket to `now`, capping at capacity. Pure; returns new state. */
export function refill(
  state: TokenBucketState,
  options: { capacity: number; refillPerSecond: number },
  now: number,
): TokenBucketState {
  const elapsedMs = Math.max(0, now - state.updatedAt);
  if (elapsedMs === 0) return state;

  const gained = (elapsedMs / 1000) * options.refillPerSecond;
  return {
    tokens: Math.min(options.capacity, state.tokens + gained),
    updatedAt: now,
  };
}

/**
 * Pure decision function shared by the in-memory and Redis limiters.
 * Keeping it pure means one set of unit tests covers both transports.
 */
export function consume(
  state: TokenBucketState,
  options: { capacity: number; refillPerSecond: number },
  now: number,
  cost = 1,
): { state: TokenBucketState; decision: RateLimitDecision } {
  const refilled = refill(state, options, now);
  const deficitToFull = options.capacity - refilled.tokens;
  const msToFull = options.refillPerSecond > 0 ? (deficitToFull / options.refillPerSecond) * 1000 : 0;

  if (refilled.tokens >= cost) {
    const next = { tokens: refilled.tokens - cost, updatedAt: now };
    return {
      state: next,
      decision: {
        allowed: true,
        remaining: Math.floor(next.tokens),
        retryAfterMs: 0,
        resetAt: now + msToFull,
      },
    };
  }

  const missing = cost - refilled.tokens;
  const retryAfterMs =
    options.refillPerSecond > 0 ? Math.ceil((missing / options.refillPerSecond) * 1000) : Infinity;

  return {
    // Denied requests do NOT consume tokens, but we still persist the refill.
    state: refilled,
    decision: {
      allowed: false,
      remaining: Math.floor(refilled.tokens),
      retryAfterMs,
      resetAt: now + msToFull,
    },
  };
}

/**
 * Single-process token bucket limiter.
 *
 * Used directly when Redis is not configured, and as the per-instance
 * first line of defence in front of the distributed limiter.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();
  private readonly now: () => number;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity <= 0) throw new RangeError('capacity must be > 0');
    if (options.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be > 0');
    this.now = options.now ?? Date.now;
  }

  /** Attempt to spend `cost` tokens for a subject (user id, IP, API key...). */
  tryConsume(key: string, cost = 1): RateLimitDecision {
    const now = this.now();
    const current = this.buckets.get(key) ?? { tokens: this.options.capacity, updatedAt: now };

    const { state, decision } = consume(current, this.options, now, cost);
    this.buckets.set(key, state);
    return decision;
  }

  /** Inspect without spending. */
  peek(key: string): number {
    const now = this.now();
    const current = this.buckets.get(key) ?? { tokens: this.options.capacity, updatedAt: now };
    return Math.floor(refill(current, this.options, now).tokens);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Drop buckets that have been idle long enough to be back at full capacity.
   * Without this the map grows unbounded in a long-lived process.
   */
  prune(): number {
    const now = this.now();
    const idleMs = (this.options.capacity / this.options.refillPerSecond) * 1000;
    let removed = 0;

    for (const [key, state] of this.buckets) {
      if (now - state.updatedAt > idleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}
