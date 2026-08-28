/**
 * `pnpm --filter @apihub/worker probe` — run one health sweep immediately.
 */
import { getDatabase, runMigrations } from '@apihub/database';
import { MemoryLockProvider } from '@apihub/runtime';

import { aggregateDaily, runHealthSweep } from '@apihub/jobs';

async function main(): Promise<void> {
  const batchArg = process.argv.find((arg) => arg.startsWith('--batch='));
  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 25;

  const handle = await getDatabase();
  await runMigrations(handle);

  console.log(`Probing up to ${batchSize} APIs...`);
  const result = await runHealthSweep(handle, new MemoryLockProvider(), batchSize);

  console.log(`  probed ${result.probed}, failed to record ${result.failed}`);

  const aggregated = await aggregateDaily(handle);
  console.log(`  aggregated ${aggregated} daily rows`);

  await handle.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Probe run failed:');
  console.error(error);
  process.exit(1);
});
