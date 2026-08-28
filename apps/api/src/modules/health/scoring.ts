/**
 * Health scoring now lives in @apihub/domain so the worker (which WRITES
 * health state) and the API (which READS it) share one implementation.
 * Re-exported here to keep the module's public surface stable.
 */
export * from '@apihub/domain';
