/**
 * Job queue abstraction (report 25, ADR-008).
 *
 * Two implementations behind one interface:
 *
 *   MemoryQueue  in-process, with the same retry/backoff/DLQ semantics.
 *                Used when Redis is absent so `pnpm dev` schedules health
 *                probes and ingestion with no extra services.
 *   BullQueue    BullMQ over Redis: durable, survives restarts, scales to
 *                multiple worker processes.
 *
 * Both provide AT-LEAST-ONCE delivery (report 23), so every handler must be
 * idempotent. That is a property of the handlers, not of the queue, and it is
 * asserted in the worker tests.
 */

/** Envelope every job carries (report 25.1). */
export interface JobEnvelope<T = unknown> {
  jobId: string;
  type: string;
  /** Payload schema version, so a handler can migrate old jobs. */
  version: number;
  data: T;
  attempt: number;
  createdAt: string;
}

export interface JobOptions {
  /** Stable id used for deduplication. Enqueuing the same id twice is a no-op. */
  jobId?: string;
  /** Delay before the job becomes eligible to run. */
  delayMs?: number;
  /** Maximum attempts including the first. */
  attempts?: number;
  /** Base backoff in milliseconds; grows exponentially with jitter. */
  backoffMs?: number;
  /** Lower numbers run sooner. */
  priority?: number;
  /** Remove from the completed set after this many entries. */
  keepCompleted?: number;
}

export type JobHandler<T = unknown> = (job: JobEnvelope<T>) => Promise<void>;

export interface QueueStatsSnapshot {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface JobQueue {
  readonly name: string;
  readonly driver: string;

  /** Enqueue a job. Resolves once the job is durably accepted. */
  add<T>(type: string, data: T, options?: JobOptions): Promise<string>;

  /** Enqueue many jobs efficiently. */
  addBulk<T>(jobs: { type: string; data: T; options?: JobOptions }[]): Promise<string[]>;

  /** Register the handler that processes jobs from this queue. */
  process<T>(handler: JobHandler<T>, concurrency?: number): void;

  /**
   * Schedule a job to repeat.
   *
   * Repeat definitions are keyed by `type`, so re-registering replaces rather
   * than duplicating them across restarts.
   *
   * `immediate` runs one pass at registration time. Off by default, matching
   * BullMQ: a daily import that also fired on every process start would
   * re-import the whole catalogue on each deploy and each dev reload.
   */
  repeat<T>(type: string, data: T, everyMs: number, options?: { immediate?: boolean }): Promise<void>;

  stats(): Promise<QueueStatsSnapshot>;

  /** Jobs that exhausted their retries (report 25, dead-letter handling). */
  failedJobs(limit?: number): Promise<JobEnvelope[]>;

  /** Re-enqueue a dead-lettered job after the underlying issue is fixed. */
  retryFailed(jobId: string): Promise<boolean>;

  /** Stop accepting work and wait for in-flight jobs to finish. */
  close(): Promise<void>;

  pause(): Promise<void>;
  resume(): Promise<void>;
}

/**
 * Exponential backoff with jitter for job retries.
 * Mirrors resilience/retry.ts so queued and inline retries behave alike.
 */
export function jobBackoff(attempt: number, baseMs: number, maxMs = 300_000): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  // Half-jitter: keeps a guaranteed minimum delay while still spreading load.
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}
