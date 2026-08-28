/**
 * Ingestion job (report 16, ADR-011).
 *
 *   Source -> Fetch -> Parse -> Validate -> Normalize -> Canonicalize
 *          -> Deduplicate -> Persist -> Publish projection -> Schedule probes
 *
 * Idempotency (report 16.3) is achieved three ways:
 *   1. Every run records the source REVISION (a hash of the payload). An
 *      unchanged revision short-circuits unless forced.
 *   2. Every record has a stable FINGERPRINT, and persistence is an upsert
 *      keyed on it.
 *   3. Row ids are derived from the fingerprint, so a re-import writes the
 *      same primary keys.
 */
import { createHash } from 'node:crypto';

import { getConfig } from '@apihub/config';
import { schema, type DatabaseHandle } from '@apihub/database';
import { getLogger } from '@apihub/logger';
import { events, withRenewingLock, type LockProvider } from '@apihub/runtime';
import { validateTargetUrl } from '@apihub/security';
import { eq, sql } from 'drizzle-orm';
import { request as undiciRequest } from 'undici';

import {
  findDuplicateClusters,
  normalize,
  resolveSlugCollisions,
  type NormalizedApi,
} from '../ingestion/normalizer.js';
import { PublicApisMarkdownAdapter, type SourceAdapter } from '../ingestion/source-adapter.js';
import { persistApis, persistCategories } from './persist.js';

const log = getLogger('worker.ingestion');

export interface IngestionInput {
  force?: boolean;
  dryRun?: boolean;
  sourceUrl?: string;
}

export interface IngestionOutcome {
  runId: string;
  status: 'succeeded' | 'failed' | 'partial' | 'skipped';
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  duplicateClusters: number;
}

/** Category descriptions and icons, so imported categories are presentable. */
const CATEGORY_ICONS: Record<string, string> = {
  'animals': 'paw-print', 'anime': 'sparkles', 'anti-malware': 'shield',
  'art-design': 'palette', 'authentication': 'key-round', 'blockchain': 'boxes',
  'books': 'book-open', 'business': 'briefcase', 'calendar': 'calendar',
  'cloud-storage-file-sharing': 'cloud', 'continuous-integration': 'git-branch',
  'cryptocurrency': 'bitcoin', 'currency': 'banknote', 'data-validation': 'check-circle',
  'development': 'code', 'dictionaries': 'book-a', 'documents-productivity': 'file-text',
  'email': 'mail', 'entertainment': 'clapperboard', 'environment': 'leaf',
  'events': 'ticket', 'finance': 'trending-up', 'food-drink': 'utensils',
  'games-comics': 'gamepad-2', 'geocoding': 'map-pin', 'government': 'landmark',
  'health': 'heart-pulse', 'jobs': 'briefcase', 'machine-learning': 'brain',
  'music': 'music', 'news': 'newspaper', 'open-data': 'database',
  'open-source-projects': 'git-fork', 'patent': 'scroll-text', 'personality': 'user',
  'phone': 'phone', 'photography': 'camera', 'science-math': 'flask-conical',
  'security': 'shield-check', 'shopping': 'shopping-cart', 'social': 'users',
  'sports-fitness': 'dumbbell', 'test-data': 'flask-round', 'text-analysis': 'file-search',
  'tracking': 'radar', 'transportation': 'train-front', 'url-shorteners': 'link',
  'vehicle': 'car', 'video': 'video', 'weather': 'cloud-sun',
};

/**
 * Fetch the source over the SAME SSRF guard the playground uses.
 *
 * The source URL is operator-configurable, which makes it user-influenced
 * input; it therefore gets the identical treatment (report 20.2).
 */
async function fetchSource(url: string): Promise<string> {
  const config = getConfig();
  const validated = await validateTargetUrl(url, {
    allowHttp: false,
    hostAllowlist: [],
    maxRedirects: 3,
  });

  const response = await undiciRequest(validated.url, {
    method: 'GET',
    headers: { 'user-agent': config.INGESTION_USER_AGENT, accept: 'text/plain, text/markdown, */*' },
    signal: AbortSignal.timeout(60_000),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Source returned HTTP ${response.statusCode}`);
  }

  return response.body.text();
}

export async function runIngestion(
  handle: DatabaseHandle,
  lockProvider: LockProvider,
  input: IngestionInput = {},
): Promise<IngestionOutcome> {
  const config = getConfig();
  const sourceUrl = input.sourceUrl ?? config.INGESTION_SOURCE_URL;
  const adapter: SourceAdapter = new PublicApisMarkdownAdapter(sourceUrl);

  // A distributed lock stops two workers importing simultaneously. Correctness
  // does not depend on it — the upserts are idempotent — but it avoids the
  // wasted work (report 23).
  const outcome = await withRenewingLock(lockProvider, 'ingestion', 60_000, () =>
    execute(handle, adapter, sourceUrl, input),
  );

  if (!outcome) {
    log.info('ingestion already running elsewhere; skipped');
    return {
      runId: 'skipped',
      status: 'skipped',
      fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0, duplicateClusters: 0,
    };
  }
  return outcome;
}

async function execute(
  handle: DatabaseHandle,
  adapter: SourceAdapter,
  sourceUrl: string,
  input: IngestionInput,
): Promise<IngestionOutcome> {
  const { db } = handle;
  const runId = schema.newId('ingestionRun');
  const startedAt = Date.now();

  const sourceId = schema.deterministicId('source', adapter.name);
  await db
    .insert(schema.apiSources)
    .values({
      id: sourceId,
      name: adapter.name,
      url: sourceUrl,
      license: adapter.license,
      transformVersion: '1',
    })
    .onConflictDoUpdate({ target: schema.apiSources.id, set: { url: sourceUrl } });

  await db.insert(schema.ingestionRuns).values({
    id: runId,
    sourceId,
    sourceName: adapter.name,
    sourceUrl,
    status: 'running',
  });

  const counters = { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0, clusters: 0 };
  const failures: { record: string; reason: string }[] = [];

  try {
    log.info({ sourceUrl }, 'fetching source');
    const raw = await fetchSource(sourceUrl);

    // The revision is a content hash. An identical payload means there is
    // nothing to do (report 16.3).
    const revision = createHash('sha256').update(raw).digest('hex').slice(0, 16);

    const [previous] = await db
      .select({ revision: schema.ingestionRuns.sourceRevision })
      .from(schema.ingestionRuns)
      .where(eq(schema.ingestionRuns.status, 'succeeded'))
      .orderBy(sql`${schema.ingestionRuns.finishedAt} DESC NULLS LAST`)
      .limit(1);

    if (!input.force && previous?.revision === revision) {
      log.info({ revision }, 'source unchanged; nothing to import');
      await finish(db, runId, 'succeeded', counters, startedAt, revision, failures);
      return { runId, status: 'succeeded', ...toOutcome(counters) };
    }

    const parsed = adapter.parse(raw);
    counters.fetched = parsed.records.length;
    failures.push(...parsed.failures.slice(0, 50));
    counters.failed = parsed.failures.length;

    log.info(
      { records: parsed.records.length, parseFailures: parsed.failures.length },
      'source parsed',
    );

    // Normalise, dropping records that cannot be made canonical.
    const normalized: NormalizedApi[] = [];
    for (const record of parsed.records) {
      const api = normalize(record, adapter.name);
      if (api) normalized.push(api);
      else {
        counters.failed += 1;
        if (failures.length < 50) {
          failures.push({ record: record.name, reason: 'could not canonicalise URL' });
        }
      }
    }

    // Deduplicate BY FINGERPRINT first: the same row can appear in several
    // category tables upstream.
    const byFingerprint = new Map<string, NormalizedApi>();
    for (const api of normalized) {
      const existing = byFingerprint.get(api.fingerprint);
      if (!existing) byFingerprint.set(api.fingerprint, api);
      else counters.skipped += 1;
    }

    // Slugs already claimed in the database, so a re-import does not collide
    // with rows from an earlier run or from the seed.
    const existingSlugRows = await db
      .select({ slug: schema.apis.slug, fingerprint: schema.apis.fingerprint })
      .from(schema.apis);
    const reservedSlugs = new Map(existingSlugRows.map((row) => [row.slug, row.fingerprint]));

    const unique = resolveSlugCollisions([...byFingerprint.values()], reservedSlugs);
    counters.clusters = findDuplicateClusters(unique).length;

    log.info(
      { unique: unique.length, duplicateClusters: counters.clusters },
      'normalisation complete',
    );

    if (input.dryRun) {
      log.info('dry run; no rows written');
      await finish(db, runId, 'succeeded', counters, startedAt, revision, failures);
      return { runId, status: 'succeeded', ...toOutcome(counters) };
    }

    // ── Persist ───────────────────────────────────────────
    //
    // Batched: see packages/jobs/src/jobs/persist.ts. Row ids are derived from
    // the fingerprint, so every foreign key is known before the write and the
    // whole batch collapses into a handful of multi-row upserts.
    const now = new Date();

    const categoryIds = await persistCategories(
      db,
      unique,
      (slug) => CATEGORY_ICONS[slug] ?? 'boxes',
    );

    const persisted = await persistApis(db, {
      apis: unique,
      categoryIds,
      sourceId,
      revision,
      now,
    });

    counters.created = persisted.created;
    counters.updated = persisted.updated;
    counters.failed += persisted.failed;
    failures.push(...persisted.failures.slice(0, Math.max(0, 50 - failures.length)));

    // Refresh denormalised counts (the search projection of report 16).
    await handle.execute(`
      UPDATE categories c
         SET api_count = (
           SELECT count(*) FROM api_category_map m
             JOIN apis a ON a.id = m.api_id
            WHERE m.category_id = c.id AND a.status = 'active'
         )
    `);

    const status = counters.failed > counters.fetched * 0.1 ? 'partial' : 'succeeded';
    await finish(db, runId, status, counters, startedAt, revision, failures);

    log.info({ ...toOutcome(counters), durationMs: Date.now() - startedAt }, 'ingestion complete');
    events.emitAsync('ingestion.completed', {
      runId,
      created: counters.created,
      updated: counters.updated,
    });

    return { runId, status, ...toOutcome(counters) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'ingestion failed');

    await db
      .update(schema.ingestionRuns)
      .set({
        status: 'failed',
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        ...counterColumns(counters),
      })
      .where(eq(schema.ingestionRuns.id, runId));

    return { runId, status: 'failed', ...toOutcome(counters) };
  }
}

type Counters = { fetched: number; created: number; updated: number; skipped: number; failed: number; clusters: number };

function counterColumns(counters: Counters) {
  return {
    recordsFetched: counters.fetched,
    recordsCreated: counters.created,
    recordsUpdated: counters.updated,
    recordsSkipped: counters.skipped,
    recordsFailed: counters.failed,
    duplicateClusters: counters.clusters,
  };
}

function toOutcome(counters: Counters) {
  return {
    fetched: counters.fetched,
    created: counters.created,
    updated: counters.updated,
    skipped: counters.skipped,
    failed: counters.failed,
    duplicateClusters: counters.clusters,
  };
}

async function finish(
  db: DatabaseHandle['db'],
  runId: string,
  status: string,
  counters: Counters,
  startedAt: number,
  revision: string,
  failures: { record: string; reason: string }[],
): Promise<void> {
  await db
    .update(schema.ingestionRuns)
    .set({
      status,
      sourceRevision: revision,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt,
      failures,
      ...counterColumns(counters),
    })
    .where(eq(schema.ingestionRuns.id, runId));
}
