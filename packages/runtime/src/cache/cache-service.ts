/**
 * Cache-aside service (report 14.1, 24).
 *
 * Read path:
 *
 *   cache.get(key)
 *     HIT  -> return
 *     MISS -> loader() -> cache.set(key, value, ttl) -> return
 *
 * On top of the basic pattern this adds the three things the report calls for
 * in 24.1 (cache-stampede protection):
 *
 *   1. TTL jitter          so entries do not all expire on the same tick.
 *   2. Single-flight       so N concurrent misses on the same key run the
 *                          loader ONCE and share the result.
 *   3. Two-tier lookup     an optional in-process L1 in front of Redis.
 *
 * Single-flight is the important one. Without it, a popular API page expiring
 * during a traffic spike sends every concurrent request to PostgreSQL at once —
 * the classic thundering herd.
 */
import { getLogger } from '@apihub/logger';

import { jitterTtl, type CacheStats, type CacheStore } from './cache-store.js';

const log = getLogger('cache');

export interface CacheServiceOptions {
  /** Shared cache (Redis) or the sole cache (memory). */
  store: CacheStore;
  /** Optional process-local L1 sitting in front of `store`. */
  l1?: CacheStore;
  /** TTL applied when a call site does not specify one. */
  defaultTtlSeconds?: number;
  /** Jitter fraction applied to every TTL. */
  jitterFraction?: number;
  /** Globally disable reads/writes (used by tests and `?nocache=1` in dev). */
  enabled?: boolean;
}

export interface GetOrSetOptions {
  ttlSeconds?: number;
  /** Skip the read but still populate the cache. Used for forced refreshes. */
  forceRefresh?: boolean;
  /** Cache negative results (null/undefined) to protect against key-miss floods. */
  cacheEmpty?: boolean;
}

/** Marker stored for a cached "no result", distinguishing it from a miss. */
const EMPTY_SENTINEL = '__apihub_empty__';

export class CacheService {
  private readonly store: CacheStore;
  private readonly l1: CacheStore | undefined;
  private readonly defaultTtl: number;
  private readonly jitterFraction: number;
  private enabled: boolean;

  /** In-flight loaders, keyed by cache key. This is the single-flight registry. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: CacheServiceOptions) {
    this.store = options.store;
    this.l1 = options.l1;
    this.defaultTtl = options.defaultTtlSeconds ?? 300;
    this.jitterFraction = options.jitterFraction ?? 0.15;
    this.enabled = options.enabled ?? true;
  }

  get storeName(): string {
    return this.l1 ? `${this.l1.name}+${this.store.name}` : this.store.name;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Read through both tiers. */
  async get<T>(key: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;

    if (this.l1) {
      const local = await this.l1.get<T>(key);
      if (local !== undefined) return local;
    }

    const shared = await this.store.get<T>(key);
    // Promote to L1 so the next read on this instance avoids the network.
    if (shared !== undefined && this.l1) {
      await this.l1.set(key, shared, { ttlSeconds: Math.min(this.defaultTtl, 60) });
    }
    return shared;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.enabled) return;

    const ttl = jitterTtl(ttlSeconds ?? this.defaultTtl, this.jitterFraction);
    await this.store.set(key, value, { ttlSeconds: ttl });
    if (this.l1) await this.l1.set(key, value, { ttlSeconds: Math.min(ttl, 60) });
  }

  /**
   * The main entry point: return the cached value, or compute, cache and
   * return it.
   *
   * Concurrent callers for the same key await the same loader promise, so the
   * expensive work happens exactly once.
   */
  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options: GetOrSetOptions = {},
  ): Promise<T> {
    if (!this.enabled) return loader();

    if (!options.forceRefresh) {
      const cached = await this.get<T | typeof EMPTY_SENTINEL>(key);
      if (cached === EMPTY_SENTINEL) return undefined as T;
      if (cached !== undefined) return cached as T;
    }

    // Join an in-flight load for the same key rather than starting another.
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await loader();

        if (value === undefined || value === null) {
          if (options.cacheEmpty) {
            // Short TTL: a negative cache entry that lives too long turns a
            // transient miss into a lasting one.
            await this.set(key, EMPTY_SENTINEL, Math.min(options.ttlSeconds ?? 60, 60));
          }
        } else {
          await this.set(key, value, options.ttlSeconds);
        }
        return value;
      } finally {
        // Always clear, including on failure, so an error is not sticky.
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
    if (this.l1) await this.l1.delete(key);
    this.inFlight.delete(key);
  }

  /**
   * Targeted invalidation after a mutation (report 24.2).
   * Never a global flush.
   */
  async invalidate(...patterns: string[]): Promise<number> {
    let removed = 0;
    for (const pattern of patterns) {
      removed += await this.store.deletePattern(pattern);
      if (this.l1) await this.l1.deletePattern(pattern);
    }
    if (removed > 0) log.debug({ patterns, removed }, 'cache invalidated');
    return removed;
  }

  async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
    if (!this.enabled) return keys.map(() => undefined);
    return this.store.getMany<T>(keys);
  }

  async increment(key: string, amount = 1, ttlSeconds?: number): Promise<number> {
    return this.store.increment(key, amount, ttlSeconds);
  }

  async isHealthy(): Promise<boolean> {
    return this.store.isHealthy();
  }

  async stats(): Promise<CacheStats> {
    return this.store.stats();
  }

  /** Number of loaders currently running. Exposed for the ops dashboard. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async close(): Promise<void> {
    await this.store.close();
    if (this.l1) await this.l1.close();
  }
}
