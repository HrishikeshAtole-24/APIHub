/**
 * Distributed locks (report 14, 23).
 *
 * Used to stop several worker instances doing the same scheduled work at once:
 * running ingestion twice, or aggregating the same day's health data twice.
 *
 * Report 23 is explicit about the limits of this:
 *
 *   "Distributed locks: coordinate scheduled work, but never rely on a lock
 *    for correctness when idempotency can solve it."
 *
 * A single-Redis lock is not safe under failover, GC pauses or clock skew. It
 * is an OPTIMISATION that stops duplicate work; correctness comes from every
 * job being idempotent. That is why acquire() returning false is never an
 * error — it just means someone else got there first.
 */
import { randomUUID } from 'node:crypto';

import { getLogger } from '@apihub/logger';

import type { RedisLike } from '../redis.js';

const log = getLogger('lock');

export interface LockHandle {
  key: string;
  token: string;
  /** Extend the lease. Returns false if the lock was lost. */
  extend: (ttlMs?: number) => Promise<boolean>;
  /** Release the lock. Safe to call more than once. */
  release: () => Promise<void>;
}

export interface LockProvider {
  readonly name: string;
  acquire(key: string, ttlMs?: number): Promise<LockHandle | null>;
}

/**
 * Release only if we still hold the lock.
 *
 * Without the token check, a process whose lease expired would delete a lock
 * that another worker has since acquired — the classic mistake.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Extend only if we still hold it, for the same reason. */
const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export class RedisLockProvider implements LockProvider {
  readonly name = 'redis';

  constructor(private readonly redis: RedisLike) {}

  async acquire(key: string, ttlMs = 30_000): Promise<LockHandle | null> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();

    try {
      // SET key token NX PX ttl - atomic "create only if absent, with expiry".
      // This MUST be a single NX operation: a plain SET would overwrite a lock
      // another worker currently holds.
      const acquired = await this.setNx(lockKey, token, ttlMs);
      if (!acquired) return null;

      return {
        key: lockKey,
        token,
        extend: async (nextTtl = ttlMs) => {
          try {
            const extended = await this.redis.eval(EXTEND_SCRIPT, 1, lockKey, token, nextTtl);
            return extended === 1;
          } catch {
            return false;
          }
        },
        release: async () => {
          try {
            await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
          } catch (error) {
            // The lease will expire on its own; losing the release is survivable.
            log.warn({ err: error, key: lockKey }, 'lock release failed; relying on TTL');
          }
        },
      };
    } catch (error) {
      log.warn({ err: error, key }, 'lock acquisition failed');
      return null;
    }
  }

  /**
   * ioredis exposes SET with modifiers via variadic args, which our structural
   * RedisLike type flattens. eval guarantees a single atomic NX+PX round trip
   * regardless of how the client types its overloads.
   */
  private async setNx(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(
      "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])",
      1,
      key,
      token,
      ttlMs,
    );
    // Redis returns OK on success and nil when NX prevented the write.
    return result === 'OK';
  }
}

/**
 * Single-process lock provider.
 *
 * Used when Redis is not configured. It is genuinely correct for a
 * single-instance deployment, which is exactly the case where Redis is absent.
 */
export class MemoryLockProvider implements LockProvider {
  readonly name = 'memory';
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();

  async acquire(key: string, ttlMs = 30_000): Promise<LockHandle | null> {
    const lockKey = `lock:${key}`;
    const now = Date.now();
    const existing = this.locks.get(lockKey);

    if (existing && existing.expiresAt > now) return null;

    const token = randomUUID();
    this.locks.set(lockKey, { token, expiresAt: now + ttlMs });

    return {
      key: lockKey,
      token,
      extend: async (nextTtl = ttlMs) => {
        const current = this.locks.get(lockKey);
        if (!current || current.token !== token) return false;
        current.expiresAt = Date.now() + nextTtl;
        return true;
      },
      release: async () => {
        const current = this.locks.get(lockKey);
        if (current?.token === token) this.locks.delete(lockKey);
      },
    };
  }

  /** Drop expired entries so the map does not grow unbounded. */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Run `task` while holding a lock, releasing it whatever happens.
 * Returns null when the lock could not be acquired.
 */
export async function withLock<T>(
  provider: LockProvider,
  key: string,
  ttlMs: number,
  task: (handle: LockHandle) => Promise<T>,
): Promise<T | null> {
  const handle = await provider.acquire(key, ttlMs);
  if (!handle) {
    log.debug({ key }, 'lock held elsewhere; skipping');
    return null;
  }

  try {
    return await task(handle);
  } finally {
    await handle.release();
  }
}

/**
 * Hold a lock across a long task, renewing it periodically.
 *
 * A long ingestion run would otherwise outlive its lease and let a second
 * worker start. The renewal timer is unref'd so it cannot keep the process
 * alive on its own.
 */
export async function withRenewingLock<T>(
  provider: LockProvider,
  key: string,
  ttlMs: number,
  task: (handle: LockHandle) => Promise<T>,
): Promise<T | null> {
  const handle = await provider.acquire(key, ttlMs);
  if (!handle) return null;

  const timer = setInterval(() => {
    void handle.extend(ttlMs).then((ok) => {
      if (!ok) log.warn({ key }, 'lost lock while task was still running');
    });
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  timer.unref?.();

  try {
    return await task(handle);
  } finally {
    clearInterval(timer);
    await handle.release();
  }
}
