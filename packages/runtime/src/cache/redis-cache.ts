/**
 * Redis-backed cache (report 14).
 *
 * Failure policy: every operation is wrapped so that a Redis outage degrades
 * into a cache miss rather than an application error. Report 35 lists "Redis
 * unavailable" as a survivable failure for caching — the database is still the
 * source of truth, so a miss is always safe.
 *
 * The one place this policy is inverted is rate limiting, which must fail
 * CLOSED. That lives in resilience/rate-limiter.ts, not here.
 */
import { getLogger } from '@apihub/logger';

import type { RedisLike } from '../redis.js';
import type { CacheSetOptions, CacheStats, CacheStore } from './cache-store.js';

const log = getLogger('cache.redis');

export class RedisCacheStore implements CacheStore {
  readonly name = 'redis';

  private hits = 0;
  private misses = 0;
  private errors = 0;

  /** The keyPrefix ioredis was configured with, including its trailing colon. */
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisLike,
    private readonly defaultTtlSeconds = 300,
    keyPrefix = '',
  ) {
    this.keyPrefix = keyPrefix;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        this.misses += 1;
        return undefined;
      }
      this.hits += 1;
      return JSON.parse(raw) as T;
    } catch (error) {
      // A corrupt entry must not wedge the endpoint; drop it and treat as a miss.
      this.errors += 1;
      this.misses += 1;
      log.warn({ err: error, key }, 'cache read failed');
      return undefined;
    }
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    try {
      const ttl = options?.ttlSeconds ?? this.defaultTtlSeconds;
      const payload = JSON.stringify(value);
      if (ttl > 0) await this.redis.setex(key, ttl, payload);
      else await this.redis.set(key, payload);
    } catch (error) {
      this.errors += 1;
      log.warn({ err: error, key }, 'cache write failed');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      this.errors += 1;
      log.warn({ err: error, key }, 'cache delete failed');
    }
  }

  /**
   * Pattern delete via SCAN, never KEYS.
   *
   * KEYS is O(n) and blocks the single-threaded Redis server for the duration,
   * which on a large keyspace is an outage. SCAN is cursor-based and yields
   * between batches (report 24.2 forbids global flushes for the same reason).
   */
  async deletePattern(pattern: string): Promise<number> {
    let cursor = '0';
    let removed = 0;

    try {
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;

        if (keys.length > 0) {
          // Keys returned by SCAN already include the keyPrefix, but del()
          // re-applies it, so strip it before deleting.
          const stripped = keys.map((key) => this.stripPrefix(key));
          removed += await this.redis.del(...stripped);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.errors += 1;
      log.warn({ err: error, pattern }, 'cache pattern delete failed');
    }
    return removed;
  }

  async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    try {
      const raw = await this.redis.mget(...keys);
      return raw.map((entry) => {
        if (entry === null) {
          this.misses += 1;
          return undefined;
        }
        this.hits += 1;
        try {
          return JSON.parse(entry) as T;
        } catch {
          return undefined;
        }
      });
    } catch (error) {
      this.errors += 1;
      this.misses += keys.length;
      log.warn({ err: error }, 'cache batch read failed');
      return keys.map(() => undefined);
    }
  }

  async increment(key: string, amount = 1, ttlSeconds?: number): Promise<number> {
    try {
      const value = await this.redis.incrby(key, amount);
      // Only set the TTL on first write, so a counter's window is not extended
      // by every subsequent increment.
      if (ttlSeconds && value === amount) await this.redis.expire(key, ttlSeconds);
      return value;
    } catch (error) {
      this.errors += 1;
      log.warn({ err: error, key }, 'cache increment failed');
      return 0;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async stats(): Promise<CacheStats> {
    const total = this.hits + this.misses;
    let size: number | null = null;
    try {
      size = await this.redis.dbsize();
    } catch {
      size = null;
    }
    return {
      name: this.name,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      size,
      errors: this.errors,
    };
  }

  async close(): Promise<void> {
    // The connection is owned by redis.ts, which closes it on shutdown.
  }

  /**
   * SCAN returns fully-qualified keys including the configured prefix, but
   * every ioredis command re-applies that prefix. Stripping it here prevents
   * `apihub:apihub:api:detail:x` on delete.
   */
  private stripPrefix(key: string): string {
    return this.keyPrefix && key.startsWith(this.keyPrefix)
      ? key.slice(this.keyPrefix.length)
      : key;
  }
}
