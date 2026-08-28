/**
 * Normalisation and deduplication (report 16, 16.2, 16.3).
 *
 * Pipeline stage: parse -> NORMALIZE -> canonicalize -> dedupe -> persist.
 *
 * The rules here are what turn a scraped table into a database record that can
 * be re-imported forever without drifting.
 */
import { slugify, clusterDuplicates, similarityRatio } from '@apihub/algorithms';
import { createHash } from 'node:crypto';

import type { SourceRecord } from './source-adapter.js';

export interface NormalizedApi {
  fingerprint: string;
  slug: string;
  name: string;
  provider: string | null;
  description: string;
  docsUrl: string;
  baseUrl: string | null;
  authType: string;
  httpsSupported: boolean;
  corsStatus: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  hasFreeTier: boolean;
  categorySlug: string;
  categoryName: string;
  tags: string[];
  popularityScore: number;
}

/**
 * Map the upstream auth string onto our AuthType enum.
 *
 * Upstream values are inconsistent ("apiKey", "API Key", "OAuth", "X-Mashape-Key",
 * "No", ""), so this is a normalisation table rather than a cast.
 */
export function normalizeAuthType(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/[`*]/g, '');

  if (value === '' || value === 'no' || value === 'none') return 'none';
  if (value.includes('oauth 1') || value === 'oauth1') return 'oauth';
  if (value.includes('oauth')) return 'oauth2';
  if (value.includes('jwt')) return 'jwt';
  if (value.includes('bearer')) return 'bearer';
  if (value.includes('basic')) return 'basic';
  if (value.includes('apikey') || value.includes('api key') || value.includes('key')) {
    return 'apiKey';
  }
  if (value.includes('user-agent') || value.includes('token')) return 'custom';
  return 'unknown';
}

export function normalizeCors(raw: string): 'yes' | 'no' | 'unknown' {
  const value = raw.trim().toLowerCase();
  if (value === 'yes') return 'yes';
  if (value === 'no') return 'no';
  return 'unknown';
}

/**
 * Canonicalise a URL (report 16.2).
 *
 * Two records pointing at `https://Example.com/docs/` and
 * `https://example.com:443/docs` are the same API. Canonicalisation makes that
 * detectable, and it must be DETERMINISTIC because the fingerprint depends on
 * it: change this function and every fingerprint changes.
 */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

    // Drop default ports.
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }

    // Trailing slashes and fragments carry no identity.
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');

    // Strip tracking parameters, which vary between copies of the same link.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return null;
  }
}

/** Registrable-ish host, used as a provider name and a dedupe blocking key. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Stable content fingerprint (report 16.3).
 *
 * Derived from source + canonical URL + normalised name. Re-running an import
 * against an unchanged record produces the same fingerprint, which is what
 * makes the upsert idempotent.
 *
 * Deliberately EXCLUDES description and auth: those change upstream without
 * the record being a different API, and including them would create a new row
 * on every wording tweak.
 */
export function fingerprintOf(sourceName: string, canonicalUrl: string, name: string): string {
  return createHash('sha256')
    .update(`${sourceName}|${canonicalUrl}|${slugify(name)}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Derive a rough popularity score from available signals.
 *
 * Upstream carries no popularity data, so this is an honest heuristic, not a
 * measurement: it favours entries that are easy to adopt. Real popularity is
 * computed later from view and playground counters by the analytics job.
 */
export function initialPopularity(record: SourceRecord, authType: string): number {
  let score = 40;
  if (authType === 'none') score += 20;
  else if (authType === 'apiKey') score += 8;
  if (record.https) score += 12;
  if (normalizeCors(record.cors) === 'yes') score += 10;
  if (record.description.length > 40) score += 6;
  // Well-known, widely-used providers.
  const host = hostOf(record.url) ?? '';
  if (/(google|github|microsoft|amazon|openstreetmap|wikipedia|nasa)\./.test(host)) score += 10;
  return Math.min(100, score);
}

/** Extract lightweight tags from the record's text. */
export function deriveTags(record: SourceRecord, authType: string): string[] {
  const tags = new Set<string>();
  tags.add(slugify(record.category));

  if (authType === 'none') tags.add('no-key');
  if (record.https) tags.add('https');
  if (normalizeCors(record.cors) === 'yes') tags.add('cors');

  const text = `${record.name} ${record.description}`.toLowerCase();
  for (const keyword of [
    'free', 'open-source', 'realtime', 'json', 'rest', 'graphql', 'webhook',
    'machine-learning', 'ai', 'geo', 'crypto', 'sandbox',
  ]) {
    if (text.includes(keyword.replace('-', ' ')) || text.includes(keyword)) tags.add(keyword);
  }

  return [...tags].slice(0, 8);
}

/** Normalise one source record. Returns null when it cannot be made usable. */
export function normalize(record: SourceRecord, sourceName: string): NormalizedApi | null {
  const canonicalUrl = canonicalizeUrl(record.url);
  if (!canonicalUrl) return null;

  const name = record.name.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return null;

  const authType = normalizeAuthType(record.auth);
  const host = hostOf(canonicalUrl);

  return {
    fingerprint: fingerprintOf(sourceName, canonicalUrl, name),
    slug: slugify(name),
    name,
    provider: host,
    description: record.description.trim().slice(0, 500),
    docsUrl: canonicalUrl,
    // The upstream dataset documents a docs URL, not an API base URL. Guessing
    // one would be inventing data, so it is left null until a probe or an
    // OpenAPI import supplies a real value.
    baseUrl: null,
    authType,
    httpsSupported: record.https,
    corsStatus: normalizeCors(record.cors),
    isFree: authType === 'none',
    hasFreeTier: true,
    categorySlug: slugify(record.category),
    categoryName: record.category,
    tags: deriveTags(record, authType),
    popularityScore: initialPopularity(record, authType),
  };
}

/**
 * Group likely duplicates (report 16.2).
 *
 * Blocking key is the host, so only records from the same domain are compared;
 * that turns an O(n^2) comparison over thousands of records into something
 * linear in practice.
 *
 * Per the report this is a REVIEW SIGNAL. It never merges automatically.
 */
export function findDuplicateClusters(apis: NormalizedApi[]): string[][] {
  return clusterDuplicates(
    apis,
    (api) => api.fingerprint,
    (api) => api.provider ?? api.slug.charAt(0),
    (a, b) => {
      if (a.docsUrl === b.docsUrl) return true;
      // Same host AND very similar name: a strong duplicate signal, but still
      // only advisory.
      return a.provider === b.provider && similarityRatio(a.slug, b.slug) > 0.85;
    },
  );
}

/**
 * Resolve slug collisions.
 *
 * Two different APIs can normalise to the same slug ("Weather API" from two
 * providers). Slugs are the public URL key and carry a UNIQUE constraint, so
 * collisions must be resolved before insert or the row is rejected.
 *
 * Collisions come from two directions and both must be handled:
 *   1. Within the incoming batch.
 *   2. Against slugs ALREADY in the database from earlier runs or the seed.
 *
 * `reserved` maps an existing slug to the fingerprint that owns it. A record
 * may keep a taken slug when the fingerprint matches, because that is the same
 * API being updated rather than a genuine collision.
 */
export function resolveSlugCollisions(
  apis: NormalizedApi[],
  reserved: ReadonlyMap<string, string> = new Map(),
): NormalizedApi[] {
  // Track how many times each slug has been claimed in this pass.
  const claims = new Map<string, number>();

  const isTaken = (slug: string, fingerprint: string): boolean => {
    if (claims.has(slug)) return true;
    const owner = reserved.get(slug);
    return owner !== undefined && owner !== fingerprint;
  };

  return apis.map((api) => {
    if (!isTaken(api.slug, api.fingerprint)) {
      claims.set(api.slug, 1);
      return api;
    }

    // Prefer a meaningful suffix (the provider's first label) over a number.
    const providerLabel = api.provider?.split('.')[0];
    const candidates: string[] = [];
    if (providerLabel && slugify(providerLabel) !== api.slug) {
      candidates.push(`${api.slug}-${slugify(providerLabel)}`);
    }
    for (let n = 2; n <= 50; n += 1) candidates.push(`${api.slug}-${n}`);

    for (const candidate of candidates) {
      if (!isTaken(candidate, api.fingerprint)) {
        claims.set(candidate, 1);
        return { ...api, slug: candidate };
      }
    }

    // Last resort: the fingerprint prefix is unique by construction.
    const fallback = `${api.slug}-${api.fingerprint.slice(0, 6)}`;
    claims.set(fallback, 1);
    return { ...api, slug: fallback };
  });
}
