/**
 * Queue factory (Factory pattern, report 22).
 *
 * Returns a BullMQ-backed queue when Redis is configured, otherwise the
 * in-process queue. Call sites receive a `JobQueue` and never branch on which.
 */
import { getConfig } from '@apihub/config';
import { getLogger } from '@apihub/logger';

import { getRedis } from '../redis.js';
import { MemoryQueue } from './memory-queue.js';
import {
  jobBackoff,
  type JobEnvelope,
  type JobHandler,
  type JobOptions,
  type JobQueue,
  type QueueStatsSnapshot,
} from './queue.js';

const log = getLogger('queue');

/**
 * BullMQ adapter (Adapter pattern).
 *
 * BullMQ's own API is wider and differently shaped than ours; this narrows it
 * to the JobQueue contract so the application is not coupled to BullMQ types.
 */
class BullQueue implements JobQueue {
  readonly driver = 'bullmq';

  private worker: { close: () => Promise<void> } | null = null;

  constructor(
    readonly name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly queue: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly WorkerCtor: any,
    private readonly connection: unknown,
  ) {}

  async add<T>(type: string, data: T, options: JobOptions = {}): Promise<string> {
    const job = await this.queue.add(
      type,
      { type, version: 1, data, createdAt: new Date().toISOString() },
      {
        jobId: options.jobId,
        delay: options.delayMs,
        attempts: options.attempts ?? 3,
        priority: options.priority,
        backoff: { type: 'exponential', delay: options.backoffMs ?? 1000 },
        // Bound the completed/failed sets so Redis memory stays predictable.
        removeOnComplete: { count: options.keepCompleted ?? 100 },
        removeOnFail: { count: 500 },
      },
    );
    return String(job.id);
  }

  async addBulk<T>(jobs: { type: string; data: T; options?: JobOptions }[]): Promise<string[]> {
    const created = await this.queue.addBulk(
      jobs.map((entry) => ({
        name: entry.type,
        data: {
          type: entry.type,
          version: 1,
          data: entry.data,
          createdAt: new Date().toISOString(),
        },
        opts: {
          jobId: entry.options?.jobId,
          delay: entry.options?.delayMs,
          attempts: entry.options?.attempts ?? 3,
          priority: entry.options?.priority,
          backoff: { type: 'exponential', delay: entry.options?.backoffMs ?? 1000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      })),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return created.map((job: any) => String(job.id));
  }

  process<T>(handler: JobHandler<T>, concurrency = 1): void {
    this.worker = new this.WorkerCtor(
      this.name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (job: any) => {
        const envelope: JobEnvelope<T> = {
          jobId: String(job.id),
          type: job.data?.type ?? job.name,
          version: job.data?.version ?? 1,
          data: job.data?.data as T,
          attempt: job.attemptsMade + 1,
          createdAt: job.data?.createdAt ?? new Date().toISOString(),
        };
        await handler(envelope);
      },
      { connection: this.connection, concurrency },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.worker as any).on('failed', (job: any, error: Error) => {
      const exhausted = job && job.attemptsMade >= (job.opts?.attempts ?? 3);
      log[exhausted ? 'error' : 'warn'](
        { queue: this.name, jobId: job?.id, attempt: job?.attemptsMade, err: error.message },
        exhausted ? 'job exhausted retries; dead-lettered' : 'job failed; will retry',
      );
    });
  }

  async repeat<T>(
    type: string,
    data: T,
    everyMs: number,
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    if (options.immediate) {
      await this.add(type, data, { jobId: `${type}:immediate:${Date.now()}` });
    }

    await this.queue.add(
      type,
      { type, version: 1, data, createdAt: new Date().toISOString() },
      {
        // A stable jobId keyed on the pattern replaces the previous repeat
        // definition instead of stacking a new one on every restart.
        repeat: { every: everyMs },
        jobId: `repeat:${type}`,
        removeOnComplete: { count: 20 },
      },
    );
  }

  async stats(): Promise<QueueStatsSnapshot> {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return {
      name: this.name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  }

  async failedJobs(limit = 50): Promise<JobEnvelope[]> {
    const jobs = await this.queue.getFailed(0, limit - 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return jobs.map((job: any) => ({
      jobId: String(job.id),
      type: job.data?.type ?? job.name,
      version: job.data?.version ?? 1,
      data: job.data?.data,
      attempt: job.attemptsMade,
      createdAt: job.data?.createdAt ?? new Date(job.timestamp).toISOString(),
    }));
  }

  async retryFailed(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    await job.retry();
    return true;
  }

  async pause(): Promise<void> {
    await this.queue.pause();
  }

  async resume(): Promise<void> {
    await this.queue.resume();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

const registry = new Map<string, JobQueue>();

/**
 * Get (or create) a queue by name.
 *
 * Memoised: creating two BullMQ Queue objects for one name would open two sets
 * of Redis connections for no benefit.
 */
export async function getQueue(name: string): Promise<JobQueue> {
  const existing = registry.get(name);
  if (existing) return existing;

  const queue = await createQueue(name);
  registry.set(name, queue);
  return queue;
}

async function createQueue(name: string): Promise<JobQueue> {
  const config = getConfig();

  if (config.redisEnabled) {
    const redis = await getRedis();
    if (redis) {
      try {
        const { Queue, Worker } = await import('bullmq');
        // BullMQ needs its own connection options rather than a shared client,
        // because blocking commands would monopolise the shared one.
        const connection = {
          url: config.REDIS_URL,
          maxRetriesPerRequest: null,
        };
        const queue = new Queue(name, { connection, prefix: `${config.REDIS_KEY_PREFIX}:q` });
        log.info({ queue: name }, 'using BullMQ queue');
        return new BullQueue(name, queue, Worker, connection);
      } catch (error) {
        log.warn({ err: error, queue: name }, 'BullMQ unavailable; using in-process queue');
      }
    }
  }

  log.info({ queue: name }, 'using in-process queue (no Redis configured)');
  return new MemoryQueue(name);
}

/** Close every queue. Called during graceful shutdown. */
export async function closeAllQueues(): Promise<void> {
  await Promise.allSettled([...registry.values()].map((queue) => queue.close()));
  registry.clear();
}

export async function allQueueStats(): Promise<QueueStatsSnapshot[]> {
  return Promise.all([...registry.values()].map((queue) => queue.stats()));
}

export { jobBackoff };
