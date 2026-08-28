/**
 * Database client factory (Factory + Strategy, report 22).
 *
 * One `Database` type, three interchangeable drivers:
 *
 *   pglite   embedded PostgreSQL compiled to WebAssembly. No server, no
 *            Docker, no install. This is what makes `pnpm dev` work on a
 *            clean machine, and what CI uses for integration tests.
 *   neon     Neon serverless PostgreSQL over HTTP (report 13, ADR-004).
 *   postgres Any standard PostgreSQL over TCP via node-postgres.
 *
 * All three are real PostgreSQL, so `tsvector`, GIN indexes, window functions
 * and CTEs behave identically. The application never learns which one it got —
 * that is the point of the abstraction, and it is why the report's rule
 * "PostgreSQL owns durable truth" holds regardless of deployment.
 *
 * The driver modules are imported dynamically so that installing, say, only
 * the Neon driver in a production image does not fail at import time.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig, type DatabaseDriver } from '@apihub/config';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from './schema/index.js';

export type Schema = typeof schema;

/**
 * Structural database type shared by every driver.
 *
 * Drizzle's per-driver types differ, so the application programs against this
 * common surface. Anything driver-specific belongs in this file.
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  db: Database;
  driver: DatabaseDriver;
  /** Close underlying connections. Called on graceful shutdown. */
  close: () => Promise<void>;
  /** Round-trip a trivial query; used by the readiness probe. */
  ping: () => Promise<number>;
  /** Execute raw SQL, discarding any result. Used by the migration runner. */
  execute: (sql: string) => Promise<void>;
  /** Execute raw SQL and return rows. Drivers disagree on result shape; this normalises it. */
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /**
   * Whether several statements can be wrapped in one transaction.
   *
   * PostgreSQL has transactional DDL, so a migration can be applied atomically
   * over a stateful connection. The Neon HTTP driver cannot: each request is
   * its own implicit transaction, with no session to hold a BEGIN open.
   */
  supportsTransactions: boolean;
}

let handle: DatabaseHandle | null = null;
let initPromise: Promise<DatabaseHandle> | null = null;

// ── Driver builders ───────────────────────────────────────────

/**
 * Locate the monorepo root by walking up from this module.
 *
 * The API, the worker and the seed CLI all run with different working
 * directories. Resolving a relative PGlite path against `process.cwd()` would
 * give each of them its OWN database, which silently breaks local development.
 */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

async function createPglite(dataDir: string): Promise<DatabaseHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');

  // Anchored to the repo root so the API, worker and CLI share one store.
  const absolute = path.isAbsolute(dataDir) ? dataDir : path.resolve(repoRoot(), dataDir);
  mkdirSync(absolute, { recursive: true });

  let client;
  try {
    client = await PGlite.create({ dataDir: absolute });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // PGlite is a SINGLE-WRITER embedded database: only one process may hold
    // the data directory. This is the most common local-development stumble,
    // so it gets an explanatory error rather than a raw "Resource busy".
    if (/resource busy|locked|EBUSY/i.test(message)) {
      throw new Error(
        [
          `Another process is already using the embedded database at ${absolute}.`,
          '',
          'PGlite allows only one writer. Either:',
          '  - stop the running API/worker before running this command, or',
          '  - point DATABASE_URL at a real PostgreSQL/Neon instance, which supports',
          '    concurrent connections so the API and worker can run side by side.',
        ].join('\n'),
      );
    }
    throw error;
  }

  const db = drizzle(client, { schema }) as unknown as Database;

  return {
    db,
    driver: 'pglite',
    close: async () => {
      await client.close();
    },
    ping: async () => {
      const started = performance.now();
      await client.query('select 1');
      return performance.now() - started;
    },
    execute: async (sql: string) => {
      await client.exec(sql);
    },
    query: async <T,>(sql: string, params?: unknown[]) => {
      const result = await client.query<T>(sql, params as unknown[] | undefined);
      return result.rows;
    },
    supportsTransactions: true,
  };
}

async function createNeon(connectionString: string): Promise<DatabaseHandle> {
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');

  const sql = neon(connectionString);
  const db = drizzle(sql, { schema }) as unknown as Database;

  return {
    db,
    driver: 'neon',
    // The HTTP driver is stateless; there is no pool to drain.
    close: async () => {},
    ping: async () => {
      const started = performance.now();
      await sql`select 1`;
      return performance.now() - started;
    },
    execute: async (statement: string) => {
      // The HTTP driver rejects multi-statement strings, so split on `;`
      // at statement boundaries and send them one at a time.
      for (const part of splitStatements(statement)) {
        await sql.query(part);
      }
    },
    query: async <T,>(statement: string, params?: unknown[]) => {
      const rows = await sql.query(statement, params as unknown[] | undefined);
      return rows as T[];
    },
    // Each HTTP request is its own implicit transaction; there is no session
    // to hold a BEGIN open across statements.
    supportsTransactions: false,
  };
}

async function createPostgres(connectionString: string, poolMax: number): Promise<DatabaseHandle> {
  const pg = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');

  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({
    connectionString,
    max: poolMax,
    // Fail fast rather than queueing forever behind an unreachable database.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  });

  const db = drizzle(pool, { schema }) as unknown as Database;

  return {
    db,
    driver: 'postgres',
    close: async () => {
      await pool.end();
    },
    ping: async () => {
      const started = performance.now();
      await pool.query('select 1');
      return performance.now() - started;
    },
    execute: async (sql: string) => {
      await pool.query(sql);
    },
    query: async <T,>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return result.rows as T[];
    },
    supportsTransactions: true,
  };
}

/**
 * Split a SQL script into individual statements.
 *
 * Naive splitting on `;` breaks on semicolons inside string literals and
 * dollar-quoted function bodies, both of which appear in our migrations, so
 * this tracks quoting state.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < script.length; i += 1) {
    const char = script[i] as string;
    const next = script[i + 1];

    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      current += char;
      if (char === '$' && script.startsWith(dollarTag, i)) {
        current += script.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === '-' && next === '-') {
        inLineComment = true;
        current += char;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        current += char;
        continue;
      }
      const dollarMatch = /^\$[A-Za-z_]*\$/.exec(script.slice(i));
      if (char === '$' && dollarMatch) {
        dollarTag = dollarMatch[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }

    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;

    if (char === ';' && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

// ── Public API ────────────────────────────────────────────────

/** Build a handle for an explicit driver. Used by tests and the CLI tools. */
export async function createDatabase(options?: {
  driver?: DatabaseDriver;
  url?: string;
  pgliteDataDir?: string;
  poolMax?: number;
}): Promise<DatabaseHandle> {
  const config = getConfig();
  const driver = options?.driver ?? config.databaseDriver;
  const url = options?.url ?? config.DATABASE_URL;

  switch (driver) {
    case 'pglite':
      return createPglite(options?.pgliteDataDir ?? config.PGLITE_DATA_DIR);
    case 'neon':
      if (!url) throw new Error('DATABASE_URL is required when DATABASE_DRIVER=neon');
      return createNeon(url);
    case 'postgres':
      if (!url) throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres');
      return createPostgres(url, options?.poolMax ?? config.DATABASE_POOL_MAX);
    default: {
      // Exhaustiveness check: adding a driver without handling it fails to compile.
      const never: never = driver;
      throw new Error(`Unsupported database driver: ${String(never)}`);
    }
  }
}

/**
 * Process-wide singleton handle.
 *
 * The report warns against Singleton for business logic but explicitly endorses
 * it for "controlled infrastructure clients" (report 22). Connection pools are
 * exactly that: creating one per request would exhaust the database.
 *
 * The in-flight promise is memoised too, so concurrent first-callers share one
 * initialisation rather than racing to build several pools.
 */
export async function getDatabase(): Promise<DatabaseHandle> {
  if (handle) return handle;
  initPromise ??= createDatabase().then((created) => {
    handle = created;
    initPromise = null;
    return created;
  });
  return initPromise;
}

/** Convenience accessor for call sites that only need the query builder. */
export async function getDb(): Promise<Database> {
  return (await getDatabase()).db;
}

export async function closeDatabase(): Promise<void> {
  if (!handle) return;
  await handle.close();
  handle = null;
}

/** Test seam: install a handle built elsewhere (e.g. a per-test PGlite instance). */
export function setDatabaseHandle(next: DatabaseHandle | null): void {
  handle = next;
}
