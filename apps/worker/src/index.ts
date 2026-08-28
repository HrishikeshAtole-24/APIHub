/**
 * Worker process entry point (report 9, 25).
 *
 * A thin process: it owns the runtime lifecycle (migrations, monitoring,
 * graceful shutdown) and delegates all job logic to @apihub/jobs, which the
 * API can also host in-process for single-process local development.
 */
import { getConfig } from '@apihub/config';
import { getDatabase, runMigrations } from '@apihub/database';
import { startScheduler } from '@apihub/jobs';
import { getLogger } from '@apihub/logger';
import {
  closeAllQueues,
  closeCache,
  closeRedis,
  events,
  startEventLoopMonitor,
} from '@apihub/runtime';

const log = getLogger('worker');

async function main(): Promise<void> {
  const config = getConfig();

  /*
   * PGlite is a single-writer embedded database: this process cannot open the
   * same data directory the API already holds. In that mode the API hosts the
   * job handlers in-process instead (see apps/api/src/index.ts), so there is
   * genuinely nothing for a separate worker to do.
   *
   * Exit 0 rather than crash-looping. `pnpm dev` starts every app in parallel,
   * and a worker that repeatedly died on a locked file would bury the API and
   * web logs in stack traces for a configuration that is working as designed.
   *
   * WORKER_STANDALONE=true forces it to start anyway, for the case where the
   * API is stopped and you want to run a sweep against the embedded database.
   */
  if (config.databaseDriver === 'pglite' && process.env['WORKER_STANDALONE'] !== 'true') {
    log.info(
      'Embedded PGlite is single-writer, so background jobs run inside the API process. ' +
        'This worker is not needed. Point DATABASE_URL at PostgreSQL/Neon to run it separately, ' +
        'or set WORKER_STANDALONE=true with the API stopped.',
    );
    process.exit(0);
  }

  log.info(
    {
      env: config.NODE_ENV,
      database: config.databaseDriver,
      queue: config.redisEnabled ? 'bullmq' : 'in-process',
      concurrency: config.HEALTH_PROBE_CONCURRENCY,
    },
    'starting APIHub worker',
  );

  const handle = await getDatabase();
  await runMigrations(handle, { log: (m) => log.info(m) });

  const stopEventLoopMonitor = startEventLoopMonitor();
  await events.connectCrossInstance();

  const scheduler = await startScheduler(handle, { schedule: true, bootstrapIfEmpty: true });
  log.info('worker ready');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down worker');

    const forceExit = setTimeout(() => {
      log.error('worker shutdown timed out; forcing exit');
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    try {
      await scheduler.stop();
      await closeAllQueues();
      stopEventLoopMonitor();
      await closeCache();
      await closeRedis();
      await handle.close();
      clearTimeout(forceExit);
      log.info('worker shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection in worker');
  });
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'failed to start worker');
  console.error(error);
  process.exit(1);
});
