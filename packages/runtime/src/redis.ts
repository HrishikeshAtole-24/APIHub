/**
 * Redis connection management (report 14, ADR-005).
 *
 * Redis is never the source of truth. It accelerates reads, coordinates work
 * across instances and holds ephemeral counters. Every call site must therefore
 * tolerate Redis being absent or unreachable — which is why this module returns
 * `null` rather than throwing when Redis is not configured, and why the
 * connection is created lazily.
 */
import { getConfig } from '@apihub/config';
import { getLogger } from '@apihub/logger';

const log = getLogger('redis');

/**
 * Minimal structural type for the ioredis client.
 *
 * Declaring the surface we actually use, instead of importing ioredis types
 * directly, keeps ioredis a genuinely optional dependency: the package type
 * checks and runs without it installed.
 */
export interface RedisLike {
  status: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  ping(): Promise<string>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
  disconnect(): void;
  info(section?: string): Promise<string>;
  dbsize(): Promise<number>;
}

let client: RedisLike | null = null;
let connecting: Promise<RedisLike | null> | null = null;
let unavailable = false;

/**
 * Get the shared Redis client, or null when Redis is not configured or could
 * not be reached. Callers branch on null and fall back to in-process behaviour.
 */
export async function getRedis(): Promise<RedisLike | null> {
  const config = getConfig();
  if (!config.redisEnabled || unavailable) return null;
  if (client) return client;

  connecting ??= connect();
  return connecting;
}

async function connect(): Promise<RedisLike | null> {
  const config = getConfig();

  try {
    const module = await import('ioredis');
    const Redis = (module.default ?? module) as unknown as new (
      url: string,
      options: Record<string, unknown>,
    ) => RedisLike;

    const instance = new Redis(config.REDIS_URL, {
      keyPrefix: `${config.REDIS_KEY_PREFIX}:`,
      // Fail fast: a request must not hang for 30s waiting on a dead Redis.
      connectTimeout: 5000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (attempt: number) => {
        if (attempt > 10) return null; // stop retrying; degrade to memory
        return Math.min(attempt * 200, 3000);
      },
    });

    instance.on('error', (error: never) => {
      log.warn({ err: error }, 'Redis error; degrading to in-process fallbacks');
    });
    instance.on('connect', () => log.info('Redis connected'));
    instance.on('close', () => log.warn('Redis connection closed'));

    await instance.ping();

    client = instance;
    connecting = null;
    return instance;
  } catch (error) {
    log.warn(
      { err: error },
      'Redis unavailable; using in-process cache, rate limiting and scheduling',
    );
    unavailable = true;
    connecting = null;
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  client = null;
  unavailable = false;
}

/** Test seam. */
export function setRedisClient(next: RedisLike | null): void {
  client = next;
  unavailable = false;
  connecting = null;
}

/** True when a live Redis connection is currently held. */
export function isRedisConnected(): boolean {
  return client !== null && client.status === 'ready';
}
