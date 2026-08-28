/**
 * Cross-cutting constants shared by the API, the worker and the web app.
 * Keeping these in one place stops magic strings drifting between services.
 */

/** Public API version prefix (report 12.1). */
export const API_VERSION = 'v1' as const;

/** Correlation header propagated browser -> API -> worker (report 27.3). */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

/** Redis key namespaces (report 14). Centralised so TTL policy stays reviewable. */
export const CACHE_KEYS = {
  apiDetail: (slug: string) => `api:detail:${slug}`,
  apiList: (hash: string) => `api:list:${hash}`,
  search: (hash: string) => `search:${hash}`,
  suggest: (prefix: string) => `suggest:${prefix}`,
  categories: () => 'categories:all',
  healthLatest: (apiId: string) => `health:latest:${apiId}`,
  healthSummary: (apiId: string) => `health:summary:${apiId}`,
  stats: () => 'stats:platform',
  rateLimit: (subject: string, route: string) => `rl:${subject}:${route}`,
  lock: (job: string, id: string) => `lock:${job}:${id}`,
  idempotency: (key: string) => `idem:${key}`,
  searchIndex: () => 'search:index:version',
} as const;

/** Cache TTLs in seconds (report 14 table). */
export const CACHE_TTL = {
  apiDetail: 900, // 15 min
  apiList: 120,
  search: 60,
  suggest: 300,
  categories: 1800,
  healthLatest: 120,
  healthSummary: 300,
  stats: 300,
} as const;

/**
 * Jitter fraction applied to every cache TTL to avoid synchronised expiry
 * (report 24.1, cache-stampede protection).
 */
export const CACHE_TTL_JITTER = 0.15;

/** BullMQ queue names (report 25). */
export const QUEUE_NAMES = {
  ingestionImport: 'ingestion.import',
  healthProbe: 'health.probe',
  healthAggregate: 'health.aggregate',
  searchReindex: 'search.reindex',
  analyticsAggregate: 'analytics.aggregate',
  maintenanceCleanup: 'maintenance.cleanup',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Pagination guardrails; prevents unbounded scans (report 20.1 DoS controls). */
export const PAGINATION = {
  defaultPageSize: 24,
  maxPageSize: 100,
  maxOffsetPage: 200,
} as const;

/**
 * Search ranking weights (report 15.1). Kept as data, not code, so the ranking
 * strategy can be tuned and unit-tested without touching query logic.
 */
export const LEXICAL_RANK_WEIGHTS = {
  textRelevance: 0.45,
  popularity: 0.15,
  reliability: 0.15,
  freshness: 0.1,
  freeTier: 0.1,
  documentation: 0.05,
} as const;

/** Hybrid (lexical + semantic) ranking weights (report 15.2). */
export const HYBRID_RANK_WEIGHTS = {
  lexical: 0.55,
  semantic: 0.25,
  reliability: 0.1,
  popularity: 0.1,
} as const;

/** Reliability score weights (report 17.2). */
export const RELIABILITY_WEIGHTS = {
  uptime30d: 0.5,
  successRate7d: 0.2,
  latency: 0.15,
  freshness: 0.1,
  incidentPenalty: 0.05,
} as const;

/** Latency (ms) at which an API scores 0 on the latency dimension. */
export const LATENCY_SCORE_CEILING_MS = 3000;

/** HTTP methods the playground is permitted to issue. */
export const ALLOWED_PLAYGROUND_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

/**
 * Request headers a user may never set through the playground: they would let a
 * caller forge identity, smuggle requests or pivot through our egress.
 */
export const FORBIDDEN_PROXY_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'expect',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
]);

/** Header values that must be redacted before anything is logged (report 20.1). */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'apikey',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-session-token',
  'x-amz-security-token',
  'x-goog-api-key',
]);

/** Query-string parameters commonly used to carry secrets. */
export const SENSITIVE_QUERY_PARAMS = new Set([
  'api_key',
  'apikey',
  'access_token',
  'token',
  'key',
  'secret',
  'client_secret',
  'password',
  'appid',
  'app_key',
]);

export const REDACTED = '[REDACTED]' as const;
