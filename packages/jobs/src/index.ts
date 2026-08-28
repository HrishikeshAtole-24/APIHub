/**
 * Background job handlers.
 *
 * Extracted from apps/worker so the SAME handlers can run in two topologies:
 *
 *   1. A dedicated worker process (production; report 9 deployment topology).
 *   2. In-process alongside the API, for single-process local development.
 *
 * The second matters because embedded PGlite is a single-writer database: two
 * processes cannot open the same data directory. Sharing the handlers as a
 * library keeps `pnpm dev` working on a clean machine without duplicating a
 * line of logic, and without the worker's behaviour drifting from production.
 */
export * from './jobs/ingestion.js';
export * from './jobs/health.js';
export * from './jobs/search.js';
export * from './jobs/persist.js';
export * from './ingestion/source-adapter.js';
export * from './ingestion/normalizer.js';
export * from './probe/http-probe.js';
export * from './scheduler.js';
