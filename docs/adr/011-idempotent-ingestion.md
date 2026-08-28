# ADR-011: Idempotent ingestion via fingerprints

**Status:** Accepted

## Context

Ingestion runs on a schedule, on demand, and after failures. It must converge, not accumulate. Every
job system delivers at least once, so "runs twice" is the normal case rather than the exception.

## Decision

Idempotency at **three** levels:

1. **Revision.** A content hash of the fetched payload. An unchanged revision short-circuits the run
   unless forced.
2. **Fingerprint.** `sha256(source | canonical URL | slugified name)`. Persistence is an upsert keyed
   on it. It deliberately excludes description and auth, which change upstream without the record
   becoming a different API.
3. **Derived ids.** Row primary keys are derived from the fingerprint, so a re-import writes the same
   keys without a lookup.

## Consequences

**Good.** Verified against the live dataset: first run `1690 created`, second run `0 created, 1690
updated`. Re-running is always safe.

**Bad.** Canonicalisation is now load-bearing. Changing `canonicalizeUrl` changes every fingerprint
and orphans existing rows, so it is documented as stable-by-contract.

**Bug this caught.** The first derived-id implementation used a hand-rolled FNV walk. FNV advances a
32-bit state, and because multiplication only propagates carries upward, the *low* bits, which the
encoder sampled, carried almost no entropy. It produced roughly 160 primary-key collisions over a
1,700-record import. Replaced with SHA-256, with a 20,000-id collision test as a regression guard.

## Revisit when

A source starts providing stable identifiers of its own, which would be a better fingerprint than a
derived one.
