/**
 * Batched persistence for ingestion.
 *
 * Why this exists
 * ---------------
 * The original implementation wrote one record at a time: five sequential
 * `await`s per API (upsert, category link, auth scheme, probe endpoint, health
 * row). Against embedded PGlite that is fine — the calls are in-process.
 *
 * Against Neon it is not. The HTTP driver makes every statement a separate
 * request, so 1,690 records became roughly 8,500 round trips. Measured from
 * India to us-east-1 that ran at ~45 records/minute: about 37 minutes for one
 * import.
 *
 * Batching into multi-row `INSERT ... ON CONFLICT` statements turns those
 * ~8,500 requests into ~40. The work is identical; only the number of network
 * round trips changes.
 *
 * Two details make the batching possible:
 *
 *  - Row ids are DERIVED from the fingerprint (ADR-011), so every foreign key
 *    is known before the insert. Nothing needs `RETURNING` to discover an id,
 *    which is what would otherwise force a per-row round trip.
 *  - Created-versus-updated is determined by reading existing fingerprints
 *    once up front, rather than inferring it from each row's `createdAt`.
 */
import { schema, type Database } from '@apihub/database';
import { getLogger } from '@apihub/logger';
import { sql } from 'drizzle-orm';

import type { NormalizedApi } from '../ingestion/normalizer.js';

const log = getLogger('worker.ingestion');

/**
 * Rows per statement.
 *
 * PostgreSQL's protocol caps a statement at 65,535 bind parameters. The `apis`
 * insert binds ~20 columns, so 200 rows is ~4,000 parameters: comfortably
 * inside the limit while still collapsing the round trips.
 */
const CHUNK_SIZE = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface PersistResult {
  created: number;
  updated: number;
  failed: number;
  failures: { record: string; reason: string }[];
}

export interface PersistInput {
  apis: NormalizedApi[];
  categoryIds: Map<string, string>;
  sourceId: string;
  revision: string;
  now: Date;
}

/**
 * Extract the useful part of a driver error.
 *
 * Drizzle's message is the entire SQL statement, which says nothing about WHY
 * the write failed. The PostgreSQL code, constraint and detail live on the
 * cause, and those identify the problem.
 */
export function describeDbError(error: unknown): string {
  const candidates = [error, (error as { cause?: unknown }).cause];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const pg = candidate as {
      code?: string;
      constraint?: string;
      detail?: string;
    };
    if (pg.code || pg.constraint || pg.detail) {
      return [
        pg.code ? `code=${pg.code}` : '',
        pg.constraint ? `constraint=${pg.constraint}` : '',
        pg.detail ? `detail=${pg.detail}` : '',
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 300);
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

export async function persistApis(db: Database, input: PersistInput): Promise<PersistResult> {
  const { apis, categoryIds, sourceId, revision, now } = input;
  const result: PersistResult = { created: 0, updated: 0, failed: 0, failures: [] };

  if (apis.length === 0) return result;

  // Which fingerprints already exist. One query, so created-vs-updated is
  // accurate without RETURNING on every row.
  const existingRows = await db
    .select({ fingerprint: schema.apis.fingerprint })
    .from(schema.apis);
  const existing = new Set(existingRows.map((row) => row.fingerprint));

  for (const api of apis) {
    if (existing.has(api.fingerprint)) result.updated += 1;
    else result.created += 1;
  }

  // Precompute every row. Ids are deterministic, so foreign keys are known
  // before anything is written.
  const apiRows = apis.map((api) => ({
    id: schema.deterministicId('api', api.fingerprint),
    slug: api.slug,
    name: api.name,
    provider: api.provider,
    description: api.description,
    docsUrl: api.docsUrl,
    baseUrl: api.baseUrl,
    authType: api.authType,
    httpsSupported: api.httpsSupported,
    corsStatus: api.corsStatus,
    isFree: api.isFree,
    hasFreeTier: api.hasFreeTier,
    status: 'active',
    popularityScore: api.popularityScore,
    tags: api.tags,
    sourceId,
    sourceRecordId: api.slug,
    sourceRevision: revision,
    fingerprint: api.fingerprint,
    importedAt: now,
  }));

  const categoryRows = apis
    .map((api) => {
      const categoryId = categoryIds.get(api.categorySlug);
      if (!categoryId) return null;
      return {
        apiId: schema.deterministicId('api', api.fingerprint),
        categoryId,
        isPrimary: true,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const authRows = apis.map((api) => ({
    id: schema.deterministicId('authScheme', api.fingerprint),
    apiId: schema.deterministicId('api', api.fingerprint),
    type: api.authType,
    location: api.authType === 'none' ? 'none' : 'header',
    parameterName: api.authType === 'apiKey' ? 'X-API-Key' : null,
    notes:
      api.authType === 'none'
        ? 'No credential required.'
        : `See ${api.docsUrl} for credential setup.`,
    signupUrl: api.authType === 'none' ? null : api.docsUrl,
  }));

  const endpointRows = apis.map((api) => ({
    id: schema.deterministicId('endpoint', api.fingerprint),
    apiId: schema.deterministicId('api', api.fingerprint),
    method: 'GET',
    path: '/',
    summary: 'Documentation endpoint',
    parameters: [],
    position: 0,
    isProbeTarget: true,
  }));

  const healthRows = apis.map((api) => ({
    apiId: schema.deterministicId('api', api.fingerprint),
    status: 'unknown',
    // Spread the first probe over the schedule interval so a fresh import does
    // not fire thousands of simultaneous outbound requests.
    nextCheckAt: new Date(Date.now() + Math.random() * 300_000),
    checkPriority: 100 - Math.round(api.popularityScore / 2),
  }));

  /** Run one chunked write, recording a failure rather than aborting the run. */
  const writeChunks = async <T>(
    label: string,
    rows: T[],
    write: (batch: T[]) => Promise<unknown>,
  ): Promise<void> => {
    const batches = chunk(rows, CHUNK_SIZE);

    for (const [index, batch] of batches.entries()) {
      try {
        await write(batch);
      } catch (error) {
        // A failed chunk loses that batch, not the import. The next run
        // re-applies it, because every write is an idempotent upsert.
        result.failed += batch.length;
        if (result.failures.length < 50) {
          result.failures.push({
            record: `${label} chunk ${index + 1}/${batches.length} (${batch.length} rows)`,
            reason: describeDbError(error),
          });
        }
        log.error({ label, chunk: index + 1, err: error }, 'ingestion chunk failed');
      }
    }
  };

  await writeChunks('apis', apiRows, (batch) =>
    db
      .insert(schema.apis)
      .values(batch)
      .onConflictDoUpdate({
        // Upsert on the fingerprint: this is what makes re-import safe.
        target: schema.apis.fingerprint,
        // A multi-row upsert must read the incoming values from `excluded`;
        // referencing the loop variable would apply one record to every row.
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          docsUrl: sql`excluded.docs_url`,
          authType: sql`excluded.auth_type`,
          httpsSupported: sql`excluded.https_supported`,
          corsStatus: sql`excluded.cors_status`,
          isFree: sql`excluded.is_free`,
          tags: sql`excluded.tags`,
          sourceRevision: sql`excluded.source_revision`,
          importedAt: sql`excluded.imported_at`,
          updatedAt: now,
        },
      }),
  );

  await writeChunks('categories', categoryRows, (batch) =>
    db.insert(schema.apiCategories).values(batch).onConflictDoNothing(),
  );

  await writeChunks('auth schemes', authRows, (batch) =>
    db.insert(schema.apiAuthSchemes).values(batch).onConflictDoNothing(),
  );

  await writeChunks('endpoints', endpointRows, (batch) =>
    db.insert(schema.apiEndpoints).values(batch).onConflictDoNothing(),
  );

  await writeChunks('health rows', healthRows, (batch) =>
    db.insert(schema.apiHealthLatest).values(batch).onConflictDoNothing(),
  );

  return result;
}

/** Upsert every category referenced by the batch, in one statement. */
export async function persistCategories(
  db: Database,
  apis: NormalizedApi[],
  iconFor: (slug: string) => string,
): Promise<Map<string, string>> {
  const categoryIds = new Map<string, string>();
  const rows: {
    id: string;
    slug: string;
    name: string;
    description: string;
    icon: string;
  }[] = [];

  for (const api of apis) {
    if (categoryIds.has(api.categorySlug)) continue;

    const id = schema.deterministicId('category', api.categorySlug);
    categoryIds.set(api.categorySlug, id);

    rows.push({
      id,
      slug: api.categorySlug,
      name: api.categoryName,
      description: `APIs in the ${api.categoryName} category`,
      icon: iconFor(api.categorySlug),
    });
  }

  for (const batch of chunk(rows, CHUNK_SIZE)) {
    await db.insert(schema.categories).values(batch).onConflictDoNothing();
  }

  return categoryIds;
}
