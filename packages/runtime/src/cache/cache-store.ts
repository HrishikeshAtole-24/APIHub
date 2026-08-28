/**
 * Cache abstraction (Strategy pattern, report 22 / 24).
 *
 * The application depends on this interface, never on Redis directly. Two
 * implementations exist:
 *
 *   MemoryCacheStore  process-local LRU. Used when REDIS_URL is unset, and as
 *                     an L1 in front of Redis when it is set.
 *   RedisCacheStore   shared, cross-instance cache.
 *
 * Report 35 requires the platform to degrade rather than fail when Redis is
 * unavailable, which is only expressible if the cache is an interface.
 */

export interface CacheSetOptions {
  /** Time to live in seconds. Omit for the store's default. */
  ttlSeconds?: number;
}

export interface CacheStore {
  readonly name: string;

  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<void>;

  /**
   * Delete every key matching a glob-style pattern.
   * Used for targeted invalidation (`api:detail:*`). Report 24.2 forbids
   * global flushes, so implementations must scan rather than call FLUSHALL.
   */
  deletePattern(pattern: string): Promise<number>;

  /** Batch read; preserves input order and returns undefined for misses. */
  getMany<T>(keys: string[]): Promise<(T | undefined)[]>;

  /** Atomic counter used by rate limiting and analytics. */
  increment(key: string, amount?: number, ttlSeconds?: number): Promise<number>;

  /** True when the backing store is reachable. */
  isHealthy(): Promise<boolean>;

  stats(): Promise<CacheStats>;

  close(): Promise<void>;
}

export interface CacheStats {
  name: string;
  hits: number;
  misses: number;
  hitRate: number;
  size: number | null;
  errors: number;
}

/**
 * Apply +/- jitter to a TTL (report 24.1, cache-stampede protection).
 *
 * Without jitter, a burst of requests that all miss at once will write entries
 * that then all expire at once, producing a synchronised thundering herd on
 * every subsequent expiry cycle.
 */
export function jitterTtl(ttlSeconds: number, fraction = 0.15): number {
  if (ttlSeconds <= 0) return ttlSeconds;
  const delta = ttlSeconds * fraction;
  return Math.max(1, Math.round(ttlSeconds + (Math.random() * 2 - 1) * delta));
}

/** A cache that stores nothing. Used in tests and when caching is disabled. */
export class NullCacheStore implements CacheStore {
  readonly name = 'null';

  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async deletePattern(): Promise<number> {
    return 0;
  }
  async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
    return keys.map(() => undefined);
  }
  async increment(): Promise<number> {
    return 0;
  }
  async isHealthy(): Promise<boolean> {
    return true;
  }
  async stats(): Promise<CacheStats> {
    return { name: this.name, hits: 0, misses: 0, hitRate: 0, size: 0, errors: 0 };
  }
  async close(): Promise<void> {}
}
