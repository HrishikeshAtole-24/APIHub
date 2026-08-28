/**
 * Job registration and scheduling.
 *
 * One function wires every queue to its handler and registers the recurring
 * schedules. Both the dedicated worker process and the embedded dev mode call
 * it, so there is exactly one description of what runs and how often.
 */
import { QUEUE_NAMES, getConfig } from '@apihub/config';
import type { DatabaseHandle } from '@apihub/database';
import { getLogger } from '@apihub/logger';
import {
  MemoryLockProvider,
  RedisLockProvider,
  getQueue,
  getRedis,
  metrics,
  type JobQueue,
  type LockProvider,
} from '@apihub/runtime';

import { aggregateDaily, pruneOldChecks, recomputePopularity, runHealthSweep } from './jobs/health.js';
import { runIngestion, type IngestionInput } from './jobs/ingestion.js';
import { reindexSearch } from './jobs/search.js';

const log = getLogger('jobs.scheduler');

export interface SchedulerHandle {
  queues: JobQueue[];
  locks: LockProvider;
  stop: () => Promise<void>;
}

export async function buildLockProvider(): Promise<LockProvider> {
  const redis = await getRedis();
  return redis ? new RedisLockProvider(redis) : new MemoryLockProvider();
}

export interface SchedulerOptions {
  /** Register recurring schedules. Off for one-shot CLI use. */
  schedule?: boolean;
  /** Run an ingestion shortly after start when the catalogue is empty. */
  bootstrapIfEmpty?: boolean;
}

export async function startScheduler(
  handle: DatabaseHandle,
  options: SchedulerOptions = {},
): Promise<SchedulerHandle> {
  const { schedule = true, bootstrapIfEmpty = false } = options;
  const config = getConfig();
  const locks = await buildLockProvider();

  const ingestionQueue = await getQueue(QUEUE_NAMES.ingestionImport);
  const healthQueue = await getQueue(QUEUE_NAMES.healthProbe);
  const aggregateQueue = await getQueue(QUEUE_NAMES.healthAggregate);
  const reindexQueue = await getQueue(QUEUE_NAMES.searchReindex);
  const maintenanceQueue = await getQueue(QUEUE_NAMES.maintenanceCleanup);

  ingestionQueue.process<IngestionInput>(async (job) => {
    log.info({ jobId: job.jobId, attempt: job.attempt }, 'ingestion job received');
    const outcome = await runIngestion(handle, locks, job.data ?? {});
    metrics.increment('ingestion_runs_total', 1, { status: outcome.status });
  }, 1);

  healthQueue.process(async () => {
    const result = await runHealthSweep(handle, locks);
    metrics.increment('health_probes_total', result.probed);
    if (result.failed > 0) metrics.increment('health_probe_failures_total', result.failed);
  }, 1);

  aggregateQueue.process(async () => {
    await aggregateDaily(handle);
    // Roll up yesterday too, in case the process was down at midnight.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await aggregateDaily(handle, yesterday);
  }, 1);

  reindexQueue.process(async () => {
    await reindexSearch(handle);
  }, 1);

  maintenanceQueue.process(async () => {
    await pruneOldChecks(handle);
    await recomputePopularity(handle);
    await handle.execute('DELETE FROM sessions WHERE expires_at < now()');
  }, 1);

  const queues = [ingestionQueue, healthQueue, aggregateQueue, reindexQueue, maintenanceQueue];

  if (schedule) {
    // Only the health sweep runs immediately: it is cheap, and it means a
    // freshly-started environment shows live status without a five-minute
    // wait. Ingestion and maintenance wait for their first interval so a
    // restart does not re-import the catalogue or run a cleanup pass.
    await healthQueue.repeat('health.probe', {}, config.HEALTH_SCHEDULE_INTERVAL_MS, {
      immediate: true,
    });
    await aggregateQueue.repeat('health.aggregate', {}, 3_600_000);
    await maintenanceQueue.repeat('maintenance.cleanup', {}, 21_600_000);
    await ingestionQueue.repeat('ingestion.import', {}, 86_400_000);
    log.info('recurring schedules registered');
  }

  if (bootstrapIfEmpty) {
    const [row] = await handle.query<{ count: string }>('SELECT count(*) AS count FROM apis');
    if (Number(row?.count ?? 0) === 0) {
      log.info('catalogue is empty; queueing an initial import');
      await ingestionQueue.add('ingestion.import', {}, { jobId: 'bootstrap' });
    }
  }

  return {
    queues,
    locks,
    stop: async () => {
      await Promise.allSettled(queues.map((queue) => queue.close()));
    },
  };
}
