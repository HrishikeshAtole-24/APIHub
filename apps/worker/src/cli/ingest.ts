/**
 * `pnpm ingest` — run an ingestion import directly, without the queue.
 *
 * Useful for first-time setup and for debugging the pipeline, since it prints
 * the outcome instead of only logging it.
 *
 * Flags: --force (ignore an unchanged revision), --dry-run (parse only).
 */
import { getDatabase, runMigrations } from '@apihub/database';
import { MemoryLockProvider } from '@apihub/runtime';

import { runIngestion } from '@apihub/jobs';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');

  const handle = await getDatabase();
  await runMigrations(handle);

  console.log(`APIHub ingestion${dryRun ? ' (dry run)' : ''}${force ? ' (forced)' : ''}`);

  const outcome = await runIngestion(handle, new MemoryLockProvider(), { force, dryRun });

  console.log('');
  console.log(`  status              ${outcome.status}`);
  console.log(`  records fetched     ${outcome.fetched}`);
  console.log(`  created             ${outcome.created}`);
  console.log(`  updated             ${outcome.updated}`);
  console.log(`  skipped (duplicate) ${outcome.skipped}`);
  console.log(`  failed              ${outcome.failed}`);
  console.log(`  duplicate clusters  ${outcome.duplicateClusters}`);

  await handle.close();
  process.exit(outcome.status === 'failed' ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error('Ingestion failed:');
  console.error(error);
  process.exit(1);
});
