/**
 * In-process job queue.
 *
 * This is not a toy: it implements the same contract BullMQ does — priority
 * ordering, delayed jobs, bounded concurrency, exponential backoff with
 * jitter, attempt limits and a dead-letter list. What it does NOT provide is
 * durability across restarts or coordination between processes, which is
 * precisely what Redis is for.
 *
 * Having it means the full ingestion and health-monitoring pipeline runs on a
 * clean machine with no Redis, and it makes worker logic testable without
 * standing up infrastructure.
 */
import { randomUUID } from 'node:crypto';

import { PriorityQueue } from '@apihub/algorithms';
import { getLogger } from '@apihub/logger';

import {
  jobBackoff,
  type JobEnvelope,
  type JobHandler,
  type JobOptions,
  type JobQueue,
  type QueueStatsSnapshot,
} from './queue.js';

const log = getLogger('queue.memory');

interface InternalJob<T = unknown> extends JobEnvelope<T> {
  maxAttempts: number;
  backoffMs: number;
  priority: number;
  /** Epoch ms before which the job must not run. */
  runAt: number;
  lastError?: string;
}

export class MemoryQueue implements JobQueue {
  readonly driver = 'memory';

  private readonly ready = new PriorityQueue<InternalJob>();
  /** Jobs waiting for their delay to elapse. */
  private readonly delayed: InternalJob[] = [];
  private readonly failed: InternalJob[] = [];
  /** Deduplication set for explicit job ids. */
  private readonly known = new Set<string>();

  private handler: JobHandler<never> | null = null;
  private concurrency = 1;
  private active = 0;
  private completedCount = 0;
  private paused = false;
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly repeaters: NodeJS.Timeout[] = [];

  constructor(readonly name: string) {}

  async add<T>(type: string, data: T, options: JobOptions = {}): Promise<string> {
    const jobId = options.jobId ?? randomUUID();

    // Deduplicate on explicit ids so a scheduler that fires twice enqueues once.
    if (options.jobId && this.known.has(jobId)) return jobId;
    this.known.add(jobId);

    const job: InternalJob<T> = {
      jobId,
      type,
      version: 1,
      data,
      attempt: 1,
      createdAt: new Date().toISOString(),
      maxAttempts: options.attempts ?? 3,
      backoffMs: options.backoffMs ?? 1000,
      priority: options.priority ?? 100,
      runAt: Date.now() + (options.delayMs ?? 0),
    };

    this.schedule(job as InternalJob);
    this.tick();
    return jobId;
  }

  async addBulk<T>(jobs: { type: string; data: T; options?: JobOptions }[]): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of jobs) {
      ids.push(await this.add(entry.type, entry.data, entry.options));
    }
    return ids;
  }

  process<T>(handler: JobHandler<T>, concurrency = 1): void {
    this.handler = handler as JobHandler<never>;
    this.concurrency = Math.max(1, concurrency);
    this.tick();
  }

  async repeat<T>(
    type: string,
    data: T,
    everyMs: number,
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    if (options.immediate) {
      await this.add(type, data, { jobId: `${type}:${Date.now()}` });
    }

    const timer = setInterval(() => {
      void this.add(type, data, { jobId: `${type}:${Date.now()}` });
    }, everyMs);

    // Do not hold the event loop open purely for a repeater.
    timer.unref?.();
    this.repeaters.push(timer);
  }

  async stats(): Promise<QueueStatsSnapshot> {
    return {
      name: this.name,
      waiting: this.ready.size,
      active: this.active,
      completed: this.completedCount,
      failed: this.failed.length,
      delayed: this.delayed.length,
    };
  }

  async failedJobs(limit = 50): Promise<JobEnvelope[]> {
    return this.failed.slice(-limit).map((job) => ({ ...job }));
  }

  async retryFailed(jobId: string): Promise<boolean> {
    const index = this.failed.findIndex((job) => job.jobId === jobId);
    if (index === -1) return false;

    const [job] = this.failed.splice(index, 1);
    if (!job) return false;

    job.attempt = 1;
    job.runAt = Date.now();
    this.schedule(job);
    this.tick();
    return true;
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
    this.tick();
  }

  async close(): Promise<void> {
    this.draining = true;
    for (const timer of this.repeaters) clearInterval(timer);
    this.repeaters.length = 0;
    if (this.timer) clearTimeout(this.timer);

    // Let in-flight handlers finish rather than cutting them off mid-write.
    const deadline = Date.now() + 10_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ── internals ───────────────────────────────────────────────

  private schedule(job: InternalJob): void {
    if (job.runAt > Date.now()) this.delayed.push(job);
    else this.ready.enqueue(job, job.priority);
  }

  /** Move any now-eligible delayed jobs into the ready queue. */
  private promoteDelayed(): void {
    const now = Date.now();
    for (let i = this.delayed.length - 1; i >= 0; i -= 1) {
      const job = this.delayed[i] as InternalJob;
      if (job.runAt <= now) {
        this.delayed.splice(i, 1);
        this.ready.enqueue(job, job.priority);
      }
    }
  }

  private tick(): void {
    if (this.draining || this.paused || !this.handler) return;

    this.promoteDelayed();

    while (this.active < this.concurrency && !this.ready.isEmpty) {
      const job = this.ready.dequeue();
      if (!job) break;
      void this.run(job);
    }

    // Re-arm only when there is future work, so an idle queue costs nothing.
    if (this.timer) clearTimeout(this.timer);
    if (this.delayed.length > 0 || !this.ready.isEmpty) {
      const nextRunAt = Math.min(...this.delayed.map((job) => job.runAt), Date.now() + 250);
      const wait = Math.max(25, nextRunAt - Date.now());
      this.timer = setTimeout(() => this.tick(), wait);
      this.timer.unref?.();
    }
  }

  private async run(job: InternalJob): Promise<void> {
    if (!this.handler) return;
    this.active += 1;

    try {
      await this.handler(job as never);
      this.completedCount += 1;
      this.known.delete(job.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.lastError = message;

      if (job.attempt < job.maxAttempts) {
        job.attempt += 1;
        job.runAt = Date.now() + jobBackoff(job.attempt, job.backoffMs);
        this.delayed.push(job);
        log.warn(
          { queue: this.name, jobId: job.jobId, attempt: job.attempt, err: message },
          'job failed; will retry',
        );
      } else {
        // Dead-letter: retain for inspection and controlled replay (report 25).
        this.failed.push(job);
        this.known.delete(job.jobId);
        log.error(
          { queue: this.name, jobId: job.jobId, type: job.type, err: message },
          'job exhausted retries; dead-lettered',
        );
      }
    } finally {
      this.active -= 1;
      this.tick();
    }
  }
}
