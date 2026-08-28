/**
 * Row -> contract mappers.
 *
 * This is the boundary between the database shape and the public API shape.
 * Keeping it explicit means a column rename never silently changes the wire
 * format, and the frontend depends on the contract rather than the schema.
 */
import type {
  ApiAuthScheme,
  ApiDetail,
  ApiEndpoint,
  ApiHealthSummary,
  ApiSummary,
  AuthType,
  CorsStatus,
  HealthStatus,
} from '@apihub/contracts';
import type { schema } from '@apihub/database';

/** Shape produced by the repository's summary column selection. */
export interface ApiRowWithHealth {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  description: string;
  docsUrl: string | null;
  baseUrl: string | null;
  authType: string;
  httpsSupported: boolean;
  corsStatus: string;
  isFree: boolean;
  hasFreeTier: boolean;
  status: string;
  popularityScore: number;
  tags: string[] | null;
  updatedAt: Date;
  createdAt: Date;
  healthStatus: string | null;
  healthLatency: number | null;
  healthUptime30d: number | null;
  healthReliability: number | null;
  healthCheckedAt: Date | null;
  healthFailures: number | null;
}

export interface ApiAggregates {
  averageRating: number | null;
  reviewCount: number;
  favoriteCount: number;
}

const VALID_AUTH_TYPES = new Set<AuthType>([
  'none',
  'apiKey',
  'bearer',
  'basic',
  'oauth',
  'oauth2',
  'jwt',
  'custom',
  'unknown',
]);

/** Coerce a stored string into the AuthType union, defaulting to 'unknown'. */
function toAuthType(value: string): AuthType {
  return VALID_AUTH_TYPES.has(value as AuthType) ? (value as AuthType) : 'unknown';
}

function toCorsStatus(value: string): CorsStatus {
  return value === 'yes' || value === 'no' ? value : 'unknown';
}

function toHealthStatus(value: string | null): HealthStatus {
  if (value === 'up' || value === 'degraded' || value === 'down') return value;
  return 'unknown';
}

export function toHealthSummary(row: ApiRowWithHealth): ApiHealthSummary {
  return {
    status: toHealthStatus(row.healthStatus),
    latencyMs: row.healthLatency,
    uptime30d: row.healthUptime30d,
    reliabilityScore: row.healthReliability,
    lastCheckedAt: row.healthCheckedAt?.toISOString() ?? null,
    consecutiveFailures: row.healthFailures ?? 0,
  };
}

export function toApiSummary(
  row: ApiRowWithHealth,
  categories: { id: string; slug: string; name: string }[],
  aggregates?: ApiAggregates,
): ApiSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    provider: row.provider,
    description: row.description,
    categories,
    authType: toAuthType(row.authType),
    httpsSupported: row.httpsSupported,
    corsStatus: toCorsStatus(row.corsStatus),
    isFree: row.isFree,
    hasFreeTier: row.hasFreeTier,
    docsUrl: row.docsUrl,
    baseUrl: row.baseUrl,
    status: row.status as ApiSummary['status'],
    popularityScore: Number(row.popularityScore),
    health: toHealthSummary(row),
    averageRating: aggregates?.averageRating ?? null,
    reviewCount: aggregates?.reviewCount ?? 0,
    favoriteCount: aggregates?.favoriteCount ?? 0,
    tags: row.tags ?? [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toApiEndpoint(row: typeof schema.apiEndpoints.$inferSelect): ApiEndpoint {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    summary: row.summary,
    parameters: row.parameters ?? [],
    sampleResponse: row.sampleResponse,
  };
}

export function toApiAuthScheme(row: typeof schema.apiAuthSchemes.$inferSelect): ApiAuthScheme {
  return {
    id: row.id,
    type: toAuthType(row.type),
    location: row.location as ApiAuthScheme['location'],
    parameterName: row.parameterName,
    notes: row.notes,
    signupUrl: row.signupUrl,
  };
}

export function toApiDetail(
  summary: ApiSummary,
  row: {
    longDescription?: string | null;
    rateLimit?: { requests: number | null; window: string | null; notes: string | null } | null;
    sourceName?: string | null;
    sourceUrl?: string | null;
    sourceRevision?: string | null;
    sourceLicense?: string | null;
    transformVersion?: string | null;
    importedAt?: Date | null;
    createdAt: Date;
  },
  endpoints: (typeof schema.apiEndpoints.$inferSelect)[],
  authSchemes: (typeof schema.apiAuthSchemes.$inferSelect)[],
  alternatives: { id: string; slug: string; name: string; description: string }[],
): ApiDetail {
  return {
    ...summary,
    longDescription: row.longDescription ?? null,
    endpoints: endpoints.map(toApiEndpoint),
    authSchemes: authSchemes.map(toApiAuthScheme),
    provenance: {
      // Provenance is never optional in the response: report 16.1 requires
      // every record to be traceable to its source.
      sourceName: row.sourceName ?? 'unknown',
      sourceUrl: row.sourceUrl ?? null,
      sourceRevision: row.sourceRevision ?? null,
      importedAt: row.importedAt?.toISOString() ?? null,
      transformVersion: row.transformVersion ?? null,
      license: row.sourceLicense ?? null,
    },
    rateLimit: row.rateLimit ?? null,
    alternatives,
    createdAt: row.createdAt.toISOString(),
  };
}
