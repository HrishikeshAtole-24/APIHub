import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * `generate` diffs the TypeScript schema against the previous snapshot and
 * emits SQL. It needs no database connection, so migrations can be authored
 * offline and reviewed in the pull request like any other code.
 *
 * Migrations are applied by src/migrate.ts, not by drizzle-kit push: per
 * report 29.1, production migrations run over a DIRECT (non-pooled) Neon
 * connection, and the runner is what enforces that.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || 'postgres://localhost:5432/apihub',
  },
});
