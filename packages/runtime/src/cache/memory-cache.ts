/**
 * In-process cache backed by the LRU from @apihub/algorithms.
 *
 * Roles:
 *  - Sole cache when REDIS_URL is unset (zero-setup local development).
 *  - L1 in front of Redis when it is set, saving a network hop for the
 *    hottest keys.
 *
 * Values are stored by reference, not serialised, so callers must treat what
 * they get back as immutable. Serialising would be safer but would throw away
 * the main reason an L1 exists.
 */
import { LruCache } from '@apihub/algorithms';

import type { CacheSetOptions, CacheStats, CacheStore } from './cache-store.js';

export interface MemoryCacheOptions {
  maxSize?: number;
  defaultTtlSeconds?: number;
}

/** Convert a Redis-style glob (`api:detail:*`) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const translated = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${translated}$`);
}

export class MemoryCacheStore implements CacheStore {
  readonly name = 'memory';

  private readonly cache: LruCache<string, unknown>;
  private readonly defaultTtlMs: number;
  private readonly counters = new Map<string, number>();

  constructor(options: MemoryCacheOptions = {}) {
    this.cache = new LruCache<string, unknown>({
      maxSize: options.maxSize ?? 5000,
      ttlMs: (options.defaultTtlSeconds ?? 300) * 1000,
    });
    this.defaultTtlMs = (options.defaultTtlSeconds ?? 300) * 1000;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    const ttlMs = options?.ttlSeconds ? options.ttlSeconds * 1000 : this.defaultTtlMs;
    this.cache.put(key, value, ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    this.counters.delete(key);
  }

  async deletePattern(pattern: string): Promise<number> {
    const matcher = globToRegExp(pattern);
    let removed = 0;

    for (const key of this.cache.keys()) {
      if (matcher.test(key)) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    for (const key of [...this.counters.keys()]) {
      if (matcher.test(key)) {
        this.counters.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
    return keys.map((key) => this.cache.get(key) as T | undefined);
  }

  async increment(key: string, amount = 1): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + amount;
    this.counters.set(key, next);
    return next;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async stats(): Promise<CacheStats> {
    const inner = this.cache.stats();
    return {
      name: this.name,
      hits: inner.hits,
      misses: inner.misses,
      hitRate: inner.hitRate,
      size: inner.size,
      errors: 0,
    };
  }

  /** Periodic maintenance: drop expired entries so memory is reclaimed. */
  prune(): number {
    return this.cache.prune();
  }

  async close(): Promise<void> {
    this.cache.clear();
    this.counters.clear();
  }
}
