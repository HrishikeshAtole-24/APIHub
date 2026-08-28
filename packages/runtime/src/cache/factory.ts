/**
 * Cache factory (report 14, 24).
 *
 * Builds the CacheService the whole application shares, choosing tiers based
 * on what infrastructure is actually available:
 *
 *   Redis configured  ->  memory L1 + Redis L2
 *   Redis absent      ->  memory only
 */
import { CACHE_TTL_JITTER, getConfig } from '@apihub/config';
import { getLogger } from '@apihub/logger';

import { getRedis } from '../redis.js';
import { CacheService } from './cache-service.js';
import { MemoryCacheStore } from './memory-cache.js';
import { RedisCacheStore } from './redis-cache.js';

const log = getLogger('cache');

let service: CacheService | null = null;
let building: Promise<CacheService> | null = null;

async function build(): Promise<CacheService> {
  const config = getConfig();
  const redis = await getRedis();

  if (redis) {
    log.info('cache: memory L1 + Redis L2');
    return new CacheService({
      store: new RedisCacheStore(redis, 300, `${config.REDIS_KEY_PREFIX}:`),
      // The L1 is small and short-lived on purpose: it absorbs hot-key traffic
      // without holding stale data long enough to be noticeable after an
      // invalidation on another instance.
      l1: new MemoryCacheStore({ maxSize: 1000, defaultTtlSeconds: 30 }),
      defaultTtlSeconds: 300,
      jitterFraction: CACHE_TTL_JITTER,
    });
  }

  log.info('cache: in-process only (no Redis configured)');
  return new CacheService({
    store: new MemoryCacheStore({ maxSize: 10_000, defaultTtlSeconds: 300 }),
    defaultTtlSeconds: 300,
    jitterFraction: CACHE_TTL_JITTER,
  });
}

/** Shared cache service. Memoised, including the in-flight construction. */
export async function getCache(): Promise<CacheService> {
  if (service) return service;
  building ??= build().then((built) => {
    service = built;
    building = null;
    return built;
  });
  return building;
}

export async function closeCache(): Promise<void> {
  await service?.close();
  service = null;
  building = null;
}

/** Test seam. */
export function setCacheService(next: CacheService | null): void {
  service = next;
  building = null;
}
