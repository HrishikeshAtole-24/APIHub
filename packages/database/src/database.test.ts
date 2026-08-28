/**
 * Migration and schema integration tests (report 28: "Migration | DB evolution
 * | migration validation").
 *
 * These run against a real, throwaway PostgreSQL instance (PGlite in memory),
 * so they exercise actual DDL, actual constraints and actual full-text search
 * rather than a mock.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, splitStatements, type DatabaseHandle } from './client.js';
import { loadMigrations, pendingMigrations, runMigrations } from './migrate.js';
import { deterministicId, newId } from './schema/ids.js';

const TEST_DIR = path.resolve(process.cwd(), '.data/test-pglite');

let handle: DatabaseHandle;

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  handle = await createDatabase({ driver: 'pglite', pgliteDataDir: TEST_DIR });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores semicolons inside string literals', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT 2")).toEqual(["SELECT 'a;b'", 'SELECT 2']);
  });

  it('ignores semicolons inside dollar-quoted bodies', () => {
    const script = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1';
    const parts = splitStatements(script);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('RETURN 1;');
    expect(parts[1]).toBe('SELECT 1');
  });
});

describe('identifiers', () => {
  it('generates prefixed ids', () => {
    const id = newId('api');
    expect(id).toMatch(/^api_[0-9a-z]{22}$/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('user')));
    expect(ids.size).toBe(2000);
  });

  it('resists collisions across many deterministic ids', () => {
    // Regression guard: a hand-rolled FNV variant previously produced ~160
    // primary-key collisions over a 1,700-record import.
    const ids = new Set(
      Array.from({ length: 20_000 }, (_, i) => deterministicId('api', `public-apis|api-${i}`)),
    );
    expect(ids.size).toBe(20_000);
  });

  it('derives the same id from the same fingerprint, enabling idempotent import', () => {
    const a = deterministicId('api', 'openweathermap|https://openweathermap.org');
    const b = deterministicId('api', 'openweathermap|https://openweathermap.org');
    const c = deterministicId('api', 'coingecko|https://coingecko.com');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^api_/);
  });
});

describe('migrations', () => {
  it('discovers migration files in order', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations[0]?.name).toBe('0000_init.sql');
    expect(migrations[1]?.name).toBe('0001_fulltext.sql');
    for (const migration of migrations) {
      expect(migration.statements.length).toBeGreaterThan(0);
      expect(migration.checksum).toHaveLength(64);
    }
  });

  it('applies every migration against real PostgreSQL', async () => {
    const result = await runMigrations(handle);
    expect(result.applied.length).toBeGreaterThanOrEqual(2);
    expect(await pendingMigrations(handle)).toEqual([]);
  });

  it('is idempotent when run a second time', async () => {
    const result = await runMigrations(handle);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
  });

  it('creates every expected table', async () => {
    const rows = await handle.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = new Set(rows.map((row) => row.table_name));

    for (const expected of [
      'users',
      'sessions',
      'apis',
      'categories',
      'api_category_map',
      'api_endpoints',
      'api_auth_schemes',
      'api_sources',
      'api_embeddings',
      'api_health_checks',
      'api_health_daily',
      'api_health_latest',
      'incidents',
      'favorites',
      'collections',
      'collection_items',
      'reviews',
      'review_votes',
      'ingestion_runs',
      'audit_logs',
      'search_queries',
      'api_views',
      'playground_runs',
    ]) {
      expect(tables.has(expected), `missing table: ${expected}`).toBe(true);
    }
  });

  it('creates the GIN index over the search vector', async () => {
    const rows = await handle.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'apis'",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('apis_search_vector_idx');
    expect(names).toContain('apis_slug_idx');
  });
});

describe('schema behaviour', () => {
  const sourceId = newId('source');
  const apiId = newId('api');
  const userId = newId('user');

  it('enforces the unique slug constraint', async () => {
    await handle.query('INSERT INTO api_sources (id, name) VALUES ($1, $2)', [sourceId, 'test']);
    await handle.query(
      `INSERT INTO apis (id, slug, name, description, fingerprint, source_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [apiId, 'test-api', 'Test API', 'A test API for weather forecasts', 'fp-1', sourceId],
    );

    await expect(
      handle.query(
        `INSERT INTO apis (id, slug, name, description, fingerprint)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId('api'), 'test-api', 'Duplicate', 'x', 'fp-2'],
      ),
    ).rejects.toThrow();
  });

  it('populates the search vector via the trigger', async () => {
    const rows = await handle.query<{ search_vector: string | null }>(
      'SELECT search_vector FROM apis WHERE id = $1',
      [apiId],
    );
    expect(rows[0]?.search_vector).toBeTruthy();
    // Name is weighted 'A'.
    expect(rows[0]?.search_vector).toContain('A');
  });

  it('matches full-text queries against the vector', async () => {
    const rows = await handle.query<{ slug: string }>(
      `SELECT slug FROM apis WHERE search_vector @@ to_tsquery('english', $1)`,
      ['weather'],
    );
    expect(rows.map((r) => r.slug)).toContain('test-api');
  });

  it('ranks a name match above a description-only match', async () => {
    await handle.query(
      `INSERT INTO apis (id, slug, name, description, fingerprint)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId('api'), 'weather-pro', 'Weather Pro', 'Nothing relevant here', 'fp-3'],
    );

    const rows = await handle.query<{ slug: string; rank: number }>(
      `SELECT slug, ts_rank(search_vector, to_tsquery('english', $1)) AS rank
         FROM apis
        WHERE search_vector @@ to_tsquery('english', $1)
        ORDER BY rank DESC`,
      ['weather'],
    );

    expect(rows.length).toBeGreaterThanOrEqual(2);
    // "Weather Pro" has weather in its NAME (weight A) so it must outrank
    // "Test API", which only has it in the description (weight C).
    expect(rows[0]?.slug).toBe('weather-pro');
  });

  it('updates the search vector when the row changes', async () => {
    await handle.query('UPDATE apis SET description = $1 WHERE id = $2', [
      'Cryptocurrency exchange rates',
      apiId,
    ]);

    const rows = await handle.query<{ slug: string }>(
      `SELECT slug FROM apis WHERE search_vector @@ to_tsquery('english', $1)`,
      ['cryptocurrency'],
    );
    expect(rows.map((r) => r.slug)).toContain('test-api');
  });

  it('cascades deletes from apis to dependent rows', async () => {
    const doomedId = newId('api');
    await handle.query(
      `INSERT INTO apis (id, slug, name, description, fingerprint)
       VALUES ($1, $2, $3, $4, $5)`,
      [doomedId, 'doomed', 'Doomed', 'x', 'fp-doomed'],
    );
    await handle.query(
      `INSERT INTO api_health_checks (id, api_id, status) VALUES ($1, $2, $3)`,
      [newId('healthCheck'), doomedId, 'up'],
    );

    await handle.query('DELETE FROM apis WHERE id = $1', [doomedId]);

    const remaining = await handle.query('SELECT 1 FROM api_health_checks WHERE api_id = $1', [
      doomedId,
    ]);
    expect(remaining).toHaveLength(0);
  });

  it('enforces one review per user per API', async () => {
    await handle.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
      userId,
      'test@example.com',
      'Test User',
    ]);
    await handle.query(
      'INSERT INTO reviews (id, user_id, api_id, rating_overall) VALUES ($1, $2, $3, $4)',
      [newId('review'), userId, apiId, 5],
    );

    await expect(
      handle.query(
        'INSERT INTO reviews (id, user_id, api_id, rating_overall) VALUES ($1, $2, $3, $4)',
        [newId('review'), userId, apiId, 3],
      ),
    ).rejects.toThrow();
  });

  it('enforces a unique email address', async () => {
    await expect(
      handle.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
        newId('user'),
        'test@example.com',
        'Impostor',
      ]),
    ).rejects.toThrow();
  });

  it('supports the composite favorites primary key', async () => {
    await handle.query('INSERT INTO favorites (user_id, api_id) VALUES ($1, $2)', [userId, apiId]);
    await expect(
      handle.query('INSERT INTO favorites (user_id, api_id) VALUES ($1, $2)', [userId, apiId]),
    ).rejects.toThrow();
  });
});
