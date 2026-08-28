/**
 * `pnpm db:migrate` — apply pending migrations.
 *
 * Per report 29.1, Neon migrations must use a DIRECT (non-pooled) connection.
 * DATABASE_URL_UNPOOLED is preferred when present.
 */
import { getConfig } from '@apihub/config';

import { createDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';

async function main(): Promise<void> {
  const config = getConfig();
  const usingDirect = config.databaseDriver === 'neon' && Boolean(config.DATABASE_URL_UNPOOLED);

  console.log(`APIHub migrations`);
  console.log(`  driver     ${config.databaseDriver}`);
  console.log(`  connection ${usingDirect ? 'direct (unpooled)' : 'default'}`);

  const handle = await createDatabase(
    usingDirect ? { url: config.DATABASE_URL_UNPOOLED } : undefined,
  );

  try {
    const result = await runMigrations(handle, { log: (m) => console.log(`  ${m}`) });

    if (result.applied.length === 0) {
      console.log(`  nothing to do (${result.skipped.length} already applied)`);
    } else {
      console.log(`  applied ${result.applied.length} migration(s) in ${result.durationMs}ms`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('\nMigration failed:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
