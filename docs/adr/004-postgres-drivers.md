# ADR-004: PostgreSQL with an interchangeable driver layer

**Status:** Accepted

## Context

The report specifies Neon for production. But a checkout that cannot run without a cloud account and
a connection string is a checkout most people never run, and integration tests that need a live
database are tests that get skipped.

## Decision

Program against **one `Database` type** with a driver factory selecting among three real PostgreSQL
implementations:

- `pglite` — PostgreSQL compiled to WebAssembly, embedded. Default when no `DATABASE_URL` is set.
- `neon` — serverless PostgreSQL over HTTP. Production.
- `postgres` — standard TCP via node-postgres.

All three are genuine PostgreSQL, so `tsvector`, GIN indexes, window functions, `FILTER` aggregates
and CTEs behave identically. The application never learns which one it received.

## Consequences

**Good.** `pnpm install && pnpm db:seed && pnpm dev` produces a working product with no
infrastructure. Integration tests run against real DDL, real constraints and real full-text ranking
instead of mocks. Migrating to Neon is one environment variable.

**Bad.** PGlite is **single-writer**: only one process may open the data directory. The API therefore
hosts background jobs in-process in that mode (`WORKER_EMBEDDED`), which is not the production
topology. It is also less durable under abrupt termination; killing the process mid-write can corrupt
the store, which is acceptable for a dev database and unacceptable for anything else.

**Guardrail.** Configuration refuses to boot with `pglite` when `NODE_ENV=production`.

## Revisit when

Never for production. If PGlite's WASM footprint became a problem for CI time, a containerised
PostgreSQL would be the alternative.
