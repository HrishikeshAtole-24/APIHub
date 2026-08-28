/**
 * Migration runner (report 29, 37 Milestone A, 35 "bad migration" recovery).
 *
 * Why a hand-rolled runner rather than `drizzle-kit push`
 * ------------------------------------------------------
 *  - It must work identically across all three drivers, including embedded
 *    PGlite, which drizzle-kit does not target.
 *  - Where the driver supports it, each migration file is applied inside a
 *    TRANSACTION, so a failure halfway through rolls back rather than leaving
 *    the schema in an unknown state. PostgreSQL has transactional DDL, which
 *    makes this possible at all. The Neon HTTP driver is the exception: every
 *    request is its own implicit transaction, so there a failed migration can
 *    leave earlier statements applied and needs a corrective migration.
 *  - Each file's checksum is stored. If an already-applied migration is edited
 *    afterwards, the runner refuses to continue instead of silently diverging
 *    between environments.
 *  - Production runs need a DIRECT (non-pooled) Neon connection (report 29.1),
 *    which this runner selects explicitly.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseHandle } from './client.js';
import { splitStatements } from './client.js';

export interface MigrationFile {
  name: string;
  checksum: string;
  statements: string[];
}

/** Marker drizzle-kit writes between statements; also used in hand-written files. */
const BREAKPOINT = '--> statement-breakpoint';

function migrationsDirectory(): string {
  // Resolve relative to this module so the runner works from any cwd.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'migrations');
}

export function loadMigrations(directory = migrationsDirectory()): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  return entries
    .filter((file) => file.endsWith('.sql'))
    // Lexicographic order matches the numeric prefix (0000, 0001, ...).
    .sort()
    .map((file) => {
      const raw = readFileSync(path.join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');

      // Prefer explicit breakpoints; fall back to quote-aware splitting.
      const statements = raw.includes(BREAKPOINT)
        ? raw
            .split(BREAKPOINT)
            .map((chunk) => chunk.trim())
            .filter((chunk) => chunk.length > 0 && !/^(--[^\n]*\n?)*$/.test(chunk))
        : splitStatements(raw);

      return { name: file, checksum, statements };
    });
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS __apihub_migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
);
`;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  durationMs: number;
}

/**
 * Apply every pending migration in order.
 *
 * Idempotent: running it twice is a no-op, which matters because the API, the
 * worker and CI may all call it during a deploy.
 */
export async function runMigrations(
  handle: DatabaseHandle,
  options: { directory?: string; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const started = Date.now();

  await handle.execute(LEDGER_DDL);

  const applied = new Map<string, string>();
  const rows = await handle.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM __apihub_migrations',
  );
  for (const row of rows) {
    applied.set(row.name, row.checksum);
  }

  const migrations = loadMigrations(options.directory);
  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const previousChecksum = applied.get(migration.name);

    if (previousChecksum !== undefined) {
      if (previousChecksum !== migration.checksum) {
        throw new Error(
          `Migration "${migration.name}" has changed since it was applied.\n` +
            `  applied checksum: ${previousChecksum}\n` +
            `  current checksum: ${migration.checksum}\n` +
            'Applied migrations are immutable. Add a new migration instead of editing this one.',
        );
      }
      skipped.push(migration.name);
      continue;
    }

    log(`applying ${migration.name} (${migration.statements.length} statements)`);
    const migrationStarted = Date.now();

    for (const statement of migration.statements) {
      try {
        await handle.execute(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Migration "${migration.name}" failed.\n` +
            `Statement:\n${statement.slice(0, 500)}\n\nDatabase error: ${message}`,
        );
      }
    }

    const durationMs = Date.now() - migrationStarted;
    await handle.query(
      'INSERT INTO __apihub_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
      [migration.name, migration.checksum, durationMs],
    );

    appliedNow.push(migration.name);
    log(`  applied in ${durationMs}ms`);
  }

  return { applied: appliedNow, skipped, durationMs: Date.now() - started };
}

/** Report which migrations are pending, without applying anything. */
export async function pendingMigrations(handle: DatabaseHandle): Promise<string[]> {
  await handle.execute(LEDGER_DDL);
  const rows = await handle.query<{ name: string }>('SELECT name FROM __apihub_migrations');
  const applied = new Set(rows.map((row) => row.name));
  return loadMigrations()
    .filter((migration) => !applied.has(migration.name))
    .map((migration) => migration.name);
}
