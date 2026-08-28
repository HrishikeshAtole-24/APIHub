/**
 * Prefixed identifiers.
 *
 * APIHub uses application-generated, human-readable ids (`api_7f3k2...`)
 * rather than bare UUIDs or auto-increment integers:
 *
 *  - A leaked or logged id tells you immediately what it refers to.
 *  - Ids can be generated before a database round-trip, which matters for
 *    idempotent ingestion: the fingerprint determines the id, so replaying a
 *    run produces identical rows (report 16.3).
 *  - Unlike sequential integers, they do not leak table size or allow
 *    enumeration of other users' records.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32 without I, L, O, U — avoids visually ambiguous characters. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  api: 'api',
  category: 'cat',
  endpoint: 'ep',
  authScheme: 'aus',
  source: 'src',
  ingestionRun: 'ing',
  healthCheck: 'hc',
  incident: 'inc',
  collection: 'col',
  review: 'rev',
  audit: 'aud',
  search: 'sq',
} as const;

/** The value written into an id, e.g. 'usr'. */
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
/** The name callers use, e.g. 'user'. Mapped to its prefix internally. */
export type IdKind = keyof typeof ID_PREFIXES;

/** Random, URL-safe, sortable-enough identifier: `<prefix>_<22 chars>`. */
export function newId(kind: IdKind, size = 22): string {
  const prefix = ID_PREFIXES[kind];
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return `${prefix}_${out.toLowerCase()}`;
}

/**
 * Deterministic id derived from a stable fingerprint.
 *
 * Ingestion uses this so that re-importing the same upstream record maps to
 * the same row without a lookup, which is what makes the pipeline idempotent.
 *
 * Uses SHA-256 rather than a hand-rolled hash. An earlier FNV-based version
 * collided badly in practice: FNV advances only a 32-bit state, and because
 * multiplication propagates carries upward only, the LOW bits — which are what
 * `% 32` samples for each output character — carry very little entropy. Over a
 * 1,700-record import that produced ~160 primary-key collisions. A real digest
 * gives 5 bits per character from a uniformly distributed 256-bit hash.
 */
export function deterministicId(kind: IdKind, fingerprint: string): string {
  const prefix = ID_PREFIXES[kind];
  const digest = createHash('sha256').update(`${kind}:${fingerprint}`).digest();

  let out = '';
  for (let i = 0; i < 22; i += 1) {
    // Each character consumes a distinct digest byte (22 <= 32 available).
    out += ALPHABET[(digest[i] as number) % ALPHABET.length];
  }
  return `${prefix}_${out.toLowerCase()}`;
}

export function isId(value: string, kind: IdKind): boolean {
  const prefix = ID_PREFIXES[kind];
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}
