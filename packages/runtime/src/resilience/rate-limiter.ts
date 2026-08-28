/**
 * Distributed rate limiting (report 18).
 *
 * The policy maths lives in @apihub/algorithms (token bucket, sliding window)
 * and is transport-agnostic. This module supplies the two transports:
 *
 *   MemoryRateLimiter  per-process. Correct for a single instance; with N
 *                      instances the effective limit becomes N x limit.
 *   RedisRateLimiter   shared across instances via an atomic Lua script.
 *
 * Report 18 notes that Redis has its own rate-limiting primitives but that
 * APIHub "should still implement its own well-tested policy layer so business
 * semantics are independent of a specific Redis command". That is exactly the
 * split here: identical maths, two transports, one test suite.
 *
 * FAIL CLOSED
 * -----------
 * Unlike the cache, a rate limiter that fails open is a vulnerability: an
 * attacker who can knock Redis over gets unlimited requests. When Redis errors,
 * this falls back to the in-process limiter rather than allowing the request.
 */
import { consume, type RateLimitDecision, type TokenBucketState } from '@apihub/algorithms';
import { TokenBucketLimiter } from '@apihub/algorithms';
import { getLogger } from '@apihub/logger';

import type { RedisLike } from '../redis.js';

const log = getLogger('rate-limit');

export interface RateLimitPolicy {
  /** Identifier used in metrics and headers, e.g. "search" or "playground". */
  name: string;
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Burst allowance. Defaults to `limit`. Setting it higher lets a client
   * spend a backlog quickly while keeping the sustained rate at `limit`.
   */
  burst?: number;
}

export interface RateLimiter {
  readonly name: string;
  check(key: string, policy: RateLimitPolicy, cost?: number): Promise<RateLimitDecision>;
  reset(key: string, policy: RateLimitPolicy): Promise<void>;
}

/** Build the standard RFC-style headers from a decision. */
export function rateLimitHeaders(
  policy: RateLimitPolicy,
  decision: RateLimitDecision,
): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(policy.limit),
    'RateLimit-Remaining': String(Math.max(0, decision.remaining)),
    'RateLimit-Reset': String(Math.ceil(Math.max(0, decision.resetAt - Date.now()) / 1000)),
    'RateLimit-Policy': `${policy.limit};w=${policy.windowSeconds}`,
  };
  if (!decision.allowed) {
    headers['Retry-After'] = String(Math.ceil(decision.retryAfterMs / 1000));
  }
  return headers;
}

// ── In-process ────────────────────────────────────────────────

export class MemoryRateLimiter implements RateLimiter {
  readonly name = 'memory';
  private readonly limiters = new Map<string, TokenBucketLimiter>();

  private limiterFor(policy: RateLimitPolicy): TokenBucketLimiter {
    const cacheKey = `${policy.name}:${policy.limit}:${policy.windowSeconds}:${policy.burst ?? ''}`;

    let limiter = this.limiters.get(cacheKey);
    if (!limiter) {
      limiter = new TokenBucketLimiter({
        capacity: policy.burst ?? policy.limit,
        refillPerSecond: policy.limit / policy.windowSeconds,
      });
      this.limiters.set(cacheKey, limiter);
    }
    return limiter;
  }

  async check(key: string, policy: RateLimitPolicy, cost = 1): Promise<RateLimitDecision> {
    return this.limiterFor(policy).tryConsume(key, cost);
  }

  async reset(key: string, policy: RateLimitPolicy): Promise<void> {
    this.limiterFor(policy).reset(key);
  }

  /** Periodic sweep so idle subjects do not accumulate. */
  prune(): number {
    let removed = 0;
    for (const limiter of this.limiters.values()) removed += limiter.prune();
    return removed;
  }
}

// ── Redis ─────────────────────────────────────────────────────

/**
 * Atomic token-bucket update in Lua.
 *
 * This MUST be a script rather than GET/compute/SET: between a read and a write
 * from two instances, both would see the same token count and both would allow
 * the request. Redis executes a script atomically, so the read-modify-write
 * cannot interleave.
 *
 * KEYS[1] bucket key
 * ARGV[1] capacity   ARGV[2] refill/sec   ARGV[3] now(ms)
 * ARGV[4] cost       ARGV[5] ttl seconds
 *
 * Returns { allowed, remaining(milli-tokens), retryAfterMs, resetAtMs }
 */
const TOKEN_BUCKET_SCRIPT = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])
local ttl       = tonumber(ARGV[5])

local bucket    = redis.call('HMGET', key, 'tokens', 'updated')
local tokens    = tonumber(bucket[1])
local updated   = tonumber(bucket[2])

if tokens == nil then
  tokens  = capacity
  updated = now
end

-- Lazy refill based on elapsed time.
local elapsed = math.max(0, now - updated) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry_after = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  local missing = cost - tokens
  retry_after = math.ceil((missing / refill) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'updated', now)
redis.call('EXPIRE', key, ttl)

local to_full = ((capacity - tokens) / refill) * 1000

-- Lua numbers round-trip to Redis as integers, so scale to preserve precision.
return { allowed, math.floor(tokens * 1000), retry_after, math.floor(now + to_full) }
`;

export class RedisRateLimiter implements RateLimiter {
  readonly name = 'redis';

  /** Fallback used when Redis errors, so the limiter never fails open. */
  private readonly fallback = new MemoryRateLimiter();

  constructor(private readonly redis: RedisLike) {}

  async check(key: string, policy: RateLimitPolicy, cost = 1): Promise<RateLimitDecision> {
    const capacity = policy.burst ?? policy.limit;
    const refillPerSecond = policy.limit / policy.windowSeconds;
    const bucketKey = `rl:${policy.name}:${key}`;
    // Keep the key alive for two windows so a bucket is not reset mid-window.
    const ttl = Math.ceil(policy.windowSeconds * 2);

    try {
      const result = (await this.redis.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        bucketKey,
        capacity,
        refillPerSecond,
        Date.now(),
        cost,
        ttl,
      )) as [number, number, number, number];

      const [allowed, milliTokens, retryAfterMs, resetAt] = result;
      return {
        allowed: allowed === 1,
        remaining: Math.floor(milliTokens / 1000),
        retryAfterMs,
        resetAt,
      };
    } catch (error) {
      log.warn({ err: error, policy: policy.name }, 'redis rate limit failed; using local limiter');
      // Fail closed: still enforce a limit, just a per-instance one.
      return this.fallback.check(key, policy, cost);
    }
  }

  async reset(key: string, policy: RateLimitPolicy): Promise<void> {
    try {
      await this.redis.del(`rl:${policy.name}:${key}`);
    } catch {
      // Best effort.
    }
    await this.fallback.reset(key, policy);
  }
}

/**
 * Layered limiter: a cheap local check in front of the shared one.
 *
 * A client hammering a single instance is rejected without a Redis round-trip,
 * which keeps Redis load proportional to legitimate traffic rather than to
 * attack traffic.
 */
export class LayeredRateLimiter implements RateLimiter {
  readonly name: string;
  private readonly local = new MemoryRateLimiter();

  constructor(private readonly shared: RateLimiter) {
    this.name = `memory+${shared.name}`;
  }

  async check(key: string, policy: RateLimitPolicy, cost = 1): Promise<RateLimitDecision> {
    // The local tier is deliberately generous: it exists to shed obvious abuse,
    // not to enforce the real limit, which must be counted globally.
    const localPolicy: RateLimitPolicy = {
      ...policy,
      name: `${policy.name}:local`,
      limit: policy.limit * 2,
      burst: (policy.burst ?? policy.limit) * 2,
    };

    const localDecision = await this.local.check(key, localPolicy, cost);
    if (!localDecision.allowed) return localDecision;

    return this.shared.check(key, policy, cost);
  }

  async reset(key: string, policy: RateLimitPolicy): Promise<void> {
    await this.local.reset(key, { ...policy, name: `${policy.name}:local` });
    await this.shared.reset(key, policy);
  }
}

/** Re-exported so call sites need only import from @apihub/runtime. */
export type { RateLimitDecision, TokenBucketState };
export { consume };
