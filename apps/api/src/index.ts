/**
 * API entry point.
 *
 * Responsibilities beyond starting the server:
 *  - run pending migrations (so a fresh clone works with one command),
 *  - start the event-loop lag monitor,
 *  - connect the cross-instance event bus,
 *  - shut down gracefully, draining in-flight requests before exiting.
 */
import { getConfig } from '@apihub/config';
import { getDatabase, runMigrations } from '@apihub/database';
import { getLogger } from '@apihub/logger';
import {
  closeAllQueues,
  closeCache,
  closeRedis,
  events,
  startEventLoopMonitor,
} from '@apihub/runtime';

import { startScheduler, type SchedulerHandle } from '@apihub/jobs';

import { buildServer } from './app/server.js';

const log = getLogger('api');

async function main(): Promise<void> {
  const config = getConfig();

  log.info(
    {
      env: config.NODE_ENV,
      database: config.databaseDriver,
      redis: config.redisEnabled ? 'enabled' : 'in-process fallback',
      ai: config.aiEnabled ? 'enabled' : 'disabled',
    },
    'starting APIHub API',
  );

  // Apply migrations before serving. Idempotent, so it is safe when several
  // instances start at once (report 29).
  const handle = await getDatabase();
  const migration = await runMigrations(handle, { log: (message) => log.info(message) });
  if (migration.applied.length > 0) {
    log.info({ applied: migration.applied }, 'migrations applied');
  }

  const stopEventLoopMonitor = startEventLoopMonitor();
  await events.connectCrossInstance();

  /*
   * Embedded worker.
   *
   * Enabled explicitly, and by default for PGlite. Embedded PGlite is a
   * single-writer database, so a separate worker process cannot open the same
   * data directory; hosting the SAME job handlers in this process is what lets
   * `pnpm dev` deliver the whole product on a clean machine.
   *
   * In production (Neon/PostgreSQL + Redis) this stays off and the worker runs
   * as its own independently scalable process, per report 9.
   */
  const embedWorker = config.WORKER_EMBEDDED || config.databaseDriver === 'pglite';
  let scheduler: SchedulerHandle | null = null;

  if (embedWorker) {
    scheduler = await startScheduler(handle, { schedule: true, bootstrapIfEmpty: false });
    log.info('background jobs running in-process (embedded worker)');
  }

  const { app } = await buildServer();

  await app.listen({ port: config.PORT, host: config.HOST });
  log.info(`APIHub API listening on http://${config.HOST}:${config.PORT}`);

  // ── Graceful shutdown ─────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'shutting down');

    // Force-exit if a hung connection prevents a clean close, so an
    // orchestrator is not left waiting on a stuck container.
    const forceExit = setTimeout(() => {
      log.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      // Stop accepting new requests and let in-flight ones finish first.
      await app.close();
      await scheduler?.stop();
      stopEventLoopMonitor();
      await closeAllQueues();
      await closeCache();
      await closeRedis();
      await handle.close();

      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it
  // loudly and exit so the orchestrator restarts a clean instance.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'failed to start API');
  console.error(error);
  process.exit(1);
});
