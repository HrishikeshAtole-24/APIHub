import { describe, expect, it, vi } from 'vitest';

import { CacheService } from './cache/cache-service.js';
import { globToRegExp, MemoryCacheStore } from './cache/memory-cache.js';
import { jitterTtl, NullCacheStore } from './cache/cache-store.js';
import { events, EventBus } from './events.js';
import { Histogram, MetricsRegistry } from './metrics.js';
import { MemoryQueue } from './queue/memory-queue.js';
import { jobBackoff } from './queue/queue.js';
import { CircuitBreaker, CircuitBreakerRegistry, CircuitOpenError } from './resilience/circuit-breaker.js';
import { MemoryLockProvider, withLock } from './resilience/lock.js';
import { MemoryRateLimiter, rateLimitHeaders } from './resilience/rate-limiter.js';
import {
  computeBackoff,
  isTransientError,
  mapWithConcurrency,
  withRetry,
  withTimeout,
} from './resilience/retry.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('MemoryCacheStore', () => {
  it('stores and retrieves values', async () => {
    const store = new MemoryCacheStore();
    await store.set('a', { value: 1 });
    expect(await store.get('a')).toEqual({ value: 1 });
    expect(await store.get('missing')).toBeUndefined();
  });

  it('deletes by glob pattern', async () => {
    const store = new MemoryCacheStore();
    await store.set('api:detail:one', 1);
    await store.set('api:detail:two', 2);
    await store.set('search:abc', 3);

    expect(await store.deletePattern('api:detail:*')).toBe(2);
    expect(await store.get('api:detail:one')).toBeUndefined();
    expect(await store.get('search:abc')).toBe(3);
  });

  it('translates globs without treating dots as wildcards', () => {
    expect(globToRegExp('api:*').test('api:one')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });

  it('increments counters', async () => {
    const store = new MemoryCacheStore();
    expect(await store.increment('hits')).toBe(1);
    expect(await store.increment('hits', 5)).toBe(6);
  });
});

describe('jitterTtl', () => {
  it('stays within the jitter band', () => {
    for (let i = 0; i < 200; i += 1) {
      const value = jitterTtl(100, 0.15);
      expect(value).toBeGreaterThanOrEqual(85);
      expect(value).toBeLessThanOrEqual(115);
    }
  });

  it('never returns zero for a positive TTL', () => {
    expect(jitterTtl(1, 0.9)).toBeGreaterThanOrEqual(1);
  });
});

describe('CacheService', () => {
  it('caches the loader result', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore() });
    const loader = vi.fn(async () => 'value');

    expect(await cache.getOrSet('k', loader)).toBe('value');
    expect(await cache.getOrSet('k', loader)).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent misses into a single load (single-flight)', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore() });
    let calls = 0;

    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'shared';
    };

    // Twenty concurrent requests for the same cold key.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.getOrSet('hot', loader)),
    );

    expect(results.every((r) => r === 'shared')).toBe(true);
    // This is the stampede protection: one database hit, not twenty.
    expect(calls).toBe(1);
  });

  it('clears the in-flight entry when the loader throws', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore() });

    await expect(
      cache.getOrSet('bad', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(cache.inFlightCount).toBe(0);
    // A subsequent call must be able to retry rather than reuse the failure.
    expect(await cache.getOrSet('bad', async () => 'recovered')).toBe('recovered');
  });

  it('honours forceRefresh', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore() });
    await cache.set('k', 'old');
    const value = await cache.getOrSet('k', async () => 'new', { forceRefresh: true });
    expect(value).toBe('new');
  });

  it('invalidates by pattern', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore() });
    await cache.set('api:detail:x', 1);
    await cache.set('api:detail:y', 2);
    await cache.invalidate('api:detail:*');
    expect(await cache.get('api:detail:x')).toBeUndefined();
  });

  it('promotes an L2 hit into L1', async () => {
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    const cache = new CacheService({ store: l2, l1 });

    await l2.set('k', 'from-l2');
    expect(await cache.get('k')).toBe('from-l2');
    expect(await l1.get('k')).toBe('from-l2');
  });

  it('bypasses everything when disabled', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore(), enabled: false });
    const loader = vi.fn(async () => 'x');
    await cache.getOrSet('k', loader);
    await cache.getOrSet('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('works with a null store', async () => {
    const cache = new CacheService({ store: new NullCacheStore() });
    expect(await cache.getOrSet('k', async () => 42)).toBe(42);
  });
});

describe('CircuitBreaker', () => {
  function makeClock(start = 0) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('opens once the failure rate crosses the threshold', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 0.5,
      volumeThreshold: 4,
      now: clock.now,
    });

    const failing = async () => {
      throw new Error('upstream down');
    };

    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }

    expect(breaker.getState()).toBe('open');
    // Further calls fail fast without touching the upstream.
    await expect(breaker.execute(failing)).rejects.toThrow(CircuitOpenError);
  });

  it('stays closed below the volume threshold', async () => {
    const breaker = new CircuitBreaker({ name: 'test', volumeThreshold: 10 });
    for (let i = 0; i < 3; i += 1) {
      await expect(
        breaker.execute(async () => {
          throw new Error('x');
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('closed');
  });

  it('transitions to half-open after the reset timeout, then closes on success', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 0.5,
      volumeThreshold: 2,
      resetTimeoutMs: 1000,
      successesToClose: 1,
      now: clock.now,
    });

    for (let i = 0; i < 2; i += 1) {
      await expect(
        breaker.execute(async () => {
          throw new Error('x');
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('open');

    clock.advance(1001);
    expect(breaker.getState()).toBe('half_open');

    await breaker.execute(async () => 'recovered');
    expect(breaker.getState()).toBe('closed');
  });

  it('reopens if the trial call fails', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 0.5,
      volumeThreshold: 2,
      resetTimeoutMs: 1000,
      now: clock.now,
    });

    for (let i = 0; i < 2; i += 1) {
      await expect(
        breaker.execute(async () => {
          throw new Error('x');
        }),
      ).rejects.toThrow();
    }
    clock.advance(1001);
    expect(breaker.getState()).toBe('half_open');

    await expect(
      breaker.execute(async () => {
        throw new Error('still down');
      }),
    ).rejects.toThrow();
    expect(breaker.getState()).toBe('open');
  });

  it('uses the fallback when open', async () => {
    const breaker = new CircuitBreaker({ name: 'test', volumeThreshold: 1, failureThreshold: 0.1 });
    await expect(
      breaker.execute(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();

    const result = await breaker.executeWithFallback(
      async () => 'live',
      () => 'cached',
    );
    expect(result).toBe('cached');
  });

  it('ignores errors the classifier says are not failures', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      volumeThreshold: 1,
      failureThreshold: 0.1,
      // A 404 from an upstream is a valid answer, not an outage.
      isFailure: (error) => (error as { status?: number }).status !== 404,
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        breaker.execute(async () => {
          throw Object.assign(new Error('not found'), { status: 404 });
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('closed');
  });

  it('isolates hosts in the registry', () => {
    const registry = new CircuitBreakerRegistry({ volumeThreshold: 1, failureThreshold: 0.1 });
    const a = registry.get('api.a.com');
    const b = registry.get('api.b.com');

    a.recordFailure();
    expect(a.getState()).toBe('open');
    expect(b.getState()).toBe('closed');
    expect(registry.unhealthy()).toHaveLength(1);
  });
});

describe('retry', () => {
  it('retries transient failures and eventually succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return 'ok';
      },
      { baseDelayMs: 1, sleep: async () => {} },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry non-transient failures', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('bad request'), { status: 400 });
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('bad request');

    expect(attempts).toBe(1);
  });

  it('classifies transient conditions correctly', () => {
    expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ name: 'AbortError' })).toBe(false);
  });

  it('produces bounded, jittered backoff', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const delay = computeBackoff(attempt, 100, 5000, 2);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(5000);
    }
    // Full jitter means repeated calls differ.
    const samples = new Set(Array.from({ length: 20 }, () => computeBackoff(4, 100, 5000, 2)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('enforces a timeout and reports it as ETIMEDOUT', async () => {
    await expect(
      withTimeout(
        (signal) =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => _resolve('too late'), 500);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
        20,
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('bounds concurrency', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return n;
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports per-item outcomes without failing the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('bad');
      return n * 10;
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
  });
});

describe('MemoryRateLimiter', () => {
  it('enforces the configured limit', async () => {
    const limiter = new MemoryRateLimiter();
    const policy = { name: 'search', limit: 3, windowSeconds: 60 };

    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.check('ip-1', policy)).allowed).toBe(true);
    }
    const denied = await limiter.check('ip-1', policy);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('isolates subjects', async () => {
    const limiter = new MemoryRateLimiter();
    const policy = { name: 'search', limit: 1, windowSeconds: 60 };
    expect((await limiter.check('a', policy)).allowed).toBe(true);
    expect((await limiter.check('b', policy)).allowed).toBe(true);
    expect((await limiter.check('a', policy)).allowed).toBe(false);
  });

  it('builds standard headers', () => {
    const headers = rateLimitHeaders(
      { name: 'search', limit: 60, windowSeconds: 60 },
      { allowed: false, remaining: 0, retryAfterMs: 2500, resetAt: Date.now() + 5000 },
    );
    expect(headers['RateLimit-Limit']).toBe('60');
    expect(headers['Retry-After']).toBe('3');
  });
});

describe('MemoryLockProvider', () => {
  it('grants a lock to only one holder', async () => {
    const provider = new MemoryLockProvider();
    const first = await provider.acquire('ingestion', 5000);
    const second = await provider.acquire('ingestion', 5000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await first!.release();
    expect(await provider.acquire('ingestion', 5000)).not.toBeNull();
  });

  it('releases the lock even when the task throws', async () => {
    const provider = new MemoryLockProvider();

    await expect(
      withLock(provider, 'job', 5000, async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');

    expect(await provider.acquire('job', 5000)).not.toBeNull();
  });

  it('returns null from withLock when the lock is held', async () => {
    const provider = new MemoryLockProvider();
    await provider.acquire('busy', 5000);
    const result = await withLock(provider, 'busy', 5000, async () => 'ran');
    expect(result).toBeNull();
  });
});

describe('MemoryQueue', () => {
  it('processes enqueued jobs', async () => {
    const queue = new MemoryQueue('test');
    const processed: number[] = [];

    queue.process<number>(async (job) => {
      processed.push(job.data);
    }, 2);

    await queue.add('job', 1);
    await queue.add('job', 2);
    await queue.add('job', 3);

    await vi.waitFor(() => expect(processed).toHaveLength(3), { timeout: 2000 });
    expect(processed.sort()).toEqual([1, 2, 3]);
    await queue.close();
  });

  it('respects priority ordering', async () => {
    const queue = new MemoryQueue('test');
    const order: string[] = [];

    // Enqueue before registering the handler so all jobs are queued first.
    await queue.add('job', 'low', { priority: 200 });
    await queue.add('job', 'urgent', { priority: 1 });
    await queue.add('job', 'normal', { priority: 100 });

    queue.process<string>(async (job) => {
      order.push(job.data);
    }, 1);

    await vi.waitFor(() => expect(order).toHaveLength(3), { timeout: 2000 });
    expect(order).toEqual(['urgent', 'normal', 'low']);
    await queue.close();
  });

  it('retries a failing job then dead-letters it', async () => {
    const queue = new MemoryQueue('test');
    let attempts = 0;

    queue.process(async () => {
      attempts += 1;
      throw new Error('always fails');
    }, 1);

    await queue.add('job', {}, { attempts: 3, backoffMs: 5 });

    await vi.waitFor(async () => expect((await queue.stats()).failed).toBe(1), { timeout: 5000 });
    expect(attempts).toBe(3);

    const dead = await queue.failedJobs();
    expect(dead).toHaveLength(1);
    await queue.close();
  });

  it('deduplicates jobs sharing an explicit id', async () => {
    const queue = new MemoryQueue('test');
    let processed = 0;

    await queue.add('job', 1, { jobId: 'same' });
    await queue.add('job', 1, { jobId: 'same' });
    await queue.add('job', 1, { jobId: 'same' });

    queue.process(async () => {
      processed += 1;
    }, 1);

    await flush();
    await vi.waitFor(() => expect(processed).toBe(1), { timeout: 2000 });
    await queue.close();
  });

  it('honours a delay', async () => {
    const queue = new MemoryQueue('test');
    let ran = false;

    queue.process(async () => {
      ran = true;
    }, 1);
    await queue.add('job', {}, { delayMs: 120 });

    await flush();
    expect(ran).toBe(false);
    await vi.waitFor(() => expect(ran).toBe(true), { timeout: 2000 });
    await queue.close();
  });

  it('can replay a dead-lettered job', async () => {
    const queue = new MemoryQueue('test');
    let shouldFail = true;
    let succeeded = false;

    queue.process(async () => {
      if (shouldFail) throw new Error('nope');
      succeeded = true;
    }, 1);

    await queue.add('job', {}, { attempts: 1, backoffMs: 1 });
    await vi.waitFor(async () => expect((await queue.stats()).failed).toBe(1), { timeout: 3000 });

    shouldFail = false;
    const [dead] = await queue.failedJobs();
    expect(await queue.retryFailed(dead!.jobId)).toBe(true);

    await vi.waitFor(() => expect(succeeded).toBe(true), { timeout: 3000 });
    await queue.close();
  });

  it('produces growing, bounded backoff', () => {
    expect(jobBackoff(1, 1000)).toBeLessThanOrEqual(1000);
    expect(jobBackoff(10, 1000, 60_000)).toBeLessThanOrEqual(60_000);
    expect(jobBackoff(3, 1000)).toBeGreaterThan(0);
  });
});

describe('EventBus', () => {
  it('delivers events to subscribers', async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.on('api.created', (payload) => {
      received.push(payload.slug);
    });
    await bus.emit('api.created', { apiId: 'api_1', slug: 'weather' });

    expect(received).toEqual(['weather']);
  });

  it('isolates a throwing subscriber from the others', async () => {
    const bus = new EventBus();
    let secondRan = false;

    bus.on('api.created', () => {
      throw new Error('subscriber exploded');
    }, 'bad');
    bus.on('api.created', () => {
      secondRan = true;
    }, 'good');

    // Must not reject: publishing is never allowed to fail the caller.
    await expect(bus.emit('api.created', { apiId: 'a', slug: 's' })).resolves.toBeUndefined();
    expect(secondRan).toBe(true);
  });

  it('unsubscribes', async () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('favorite.added', () => {
      count += 1;
    });

    await bus.emit('favorite.added', { userId: 'u', apiId: 'a' });
    off();
    await bus.emit('favorite.added', { userId: 'u', apiId: 'a' });

    expect(count).toBe(1);
    expect(bus.listenerCount('favorite.added')).toBe(0);
  });

  it('exposes a process-wide instance', () => {
    expect(events).toBeInstanceOf(EventBus);
  });
});

describe('metrics', () => {
  it('counts and labels series separately', () => {
    const registry = new MetricsRegistry();
    registry.increment('http_requests', 1, { route: '/apis' });
    registry.increment('http_requests', 2, { route: '/apis' });
    registry.increment('http_requests', 1, { route: '/search' });

    expect(registry.getCounter('http_requests', { route: '/apis' })).toBe(3);
    expect(registry.getCounter('http_requests', { route: '/search' })).toBe(1);
  });

  it('produces a stable series key regardless of label order', () => {
    const registry = new MetricsRegistry();
    registry.increment('x', 1, { a: '1', b: '2' });
    registry.increment('x', 1, { b: '2', a: '1' });
    expect(registry.getCounter('x', { a: '1', b: '2' })).toBe(2);
  });

  it('computes histogram quantiles', () => {
    const histogram = new Histogram([10, 50, 100, 500]);
    for (let i = 0; i < 90; i += 1) histogram.observe(5);
    for (let i = 0; i < 10; i += 1) histogram.observe(400);

    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(100);
    expect(snapshot.p50).toBe(10);
    expect(snapshot.p95).toBe(500);
    expect(snapshot.max).toBe(400);
  });

  it('times operations and records the outcome', async () => {
    const registry = new MetricsRegistry();
    await registry.time('op', async () => 'ok');
    await expect(
      registry.time('op', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();

    expect(registry.getHistogram('op', { outcome: 'success' })?.count).toBe(1);
    expect(registry.getHistogram('op', { outcome: 'error' })?.count).toBe(1);
  });

  it('renders Prometheus exposition format', () => {
    const registry = new MetricsRegistry();
    registry.increment('requests_total', 5);
    registry.gauge('queue_depth', 12);
    registry.observe('latency_ms', 42);

    const text = registry.toPrometheus();
    expect(text).toContain('# TYPE requests_total counter');
    expect(text).toContain('requests_total 5');
    expect(text).toContain('queue_depth 12');
    expect(text).toContain('latency_ms_bucket');
  });
});
