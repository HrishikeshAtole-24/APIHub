/**
 * Shared primitives: enums, envelopes, pagination and the error contract
 * (report 12.2 / 12.3).
 *
 * Everything here is a Zod schema first and a TypeScript type second, so the
 * exact same definition validates at the HTTP boundary and types the frontend.
 */
import { z } from 'zod';

// ── Domain enums ──────────────────────────────────────────────

/** Authentication model an API requires. */
export const AuthTypeSchema = z.enum([
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
export type AuthType = z.infer<typeof AuthTypeSchema>;

/** Human labels for the UI. Kept next to the enum so they cannot drift. */
export const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  none: 'No auth',
  apiKey: 'API key',
  bearer: 'Bearer token',
  basic: 'Basic auth',
  oauth: 'OAuth 1.0',
  oauth2: 'OAuth 2.0',
  jwt: 'JWT',
  custom: 'Custom',
  unknown: 'Unknown',
};

/** Whether the API sends permissive CORS headers, per upstream metadata. */
export const CorsStatusSchema = z.enum(['yes', 'no', 'unknown']);
export type CorsStatus = z.infer<typeof CorsStatusSchema>;

/** Lifecycle of a catalogue record (report 13.1 / FR-10). */
export const ApiStatusSchema = z.enum(['active', 'pending', 'deprecated', 'retired', 'rejected']);
export type ApiStatus = z.infer<typeof ApiStatusSchema>;

/** Health state machine (report 17.1). */
export const HealthStatusSchema = z.enum(['unknown', 'up', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = {
  unknown: 'Not checked',
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
};

/** Role-based authorization (report 19). */
export const UserRoleSchema = z.enum(['user', 'moderator', 'admin']);
export type UserRole = z.infer<typeof UserRoleSchema>;

/** HTTP methods the playground may issue (report 20.2). */
export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

// ── Pagination ────────────────────────────────────────────────

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(200).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginationMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export function buildPaginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

// ── Response envelope (report 12.2) ───────────────────────────

export interface ResponseMeta extends Partial<PaginationMeta> {
  requestId: string;
  /** Server processing time in milliseconds. */
  durationMs?: number;
  /** True when the payload was served from cache. Surfaced for debugging. */
  cached?: boolean;
  [key: string]: unknown;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

/** Machine-readable error codes. Clients switch on these, never on messages. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  API_NOT_FOUND: 'API_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  BLOCKED_TARGET: 'BLOCKED_TARGET',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorEnvelope {
  error: {
    code: ErrorCode | string;
    message: string;
    requestId: string;
    /** Field-level detail for validation failures only. */
    details?: { path: string; message: string }[];
    /** Seconds to wait before retrying; set on 429 and 503. */
    retryAfter?: number;
  };
}

export type ApiResponse<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function isErrorEnvelope<T>(response: ApiResponse<T>): response is ErrorEnvelope {
  return typeof response === 'object' && response !== null && 'error' in response;
}

// ── Small shared shapes ───────────────────────────────────────

export const SortOrderSchema = z.enum(['asc', 'desc']).default('desc');
export type SortOrder = z.infer<typeof SortOrderSchema>;

/** ISO-8601 timestamp as transported over JSON. */
export const IsoDateSchema = z.string();

export const IdSchema = z.string().min(1).max(64);
export const SlugSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a lowercase hyphenated slug');
