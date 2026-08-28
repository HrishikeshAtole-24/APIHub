/**
 * Typed API client (report 10.1: "use typed API clients ... from backend
 * contracts").
 *
 * One client used by both Server Components (during SSR) and Client Components
 * (in the browser). The differences are handled here:
 *
 *  - Cookies. In the browser `credentials: 'include'` carries the session. On
 *    the server there is no ambient cookie jar, so the incoming request's
 *    cookies must be forwarded explicitly.
 *  - Correlation. A request id is generated and sent so a browser action can
 *    be traced through the API logs (report 27.3).
 *  - Errors. The API's error envelope is unwrapped into a typed ApiError, so
 *    callers switch on a code rather than parsing a message.
 */
import type { ErrorEnvelope, ResponseMeta, SuccessEnvelope } from '@apihub/contracts';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly details?: { path: string; message: string }[],
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** A message safe and useful to show a user. */
  get userMessage(): string {
    if (this.isRateLimited) {
      const wait = this.retryAfter ? ` Try again in ${this.retryAfter}s.` : '';
      return `You are going a bit fast.${wait}`;
    }
    if (this.status >= 500) return 'Something went wrong on our side. Please try again.';
    return this.message;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Query parameters; undefined and empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** CSRF token for state-changing requests. */
  csrfToken?: string;
  /** Next.js cache directives for Server Component fetches. */
  next?: { revalidate?: number | false; tags?: string[] };
  cache?: RequestCache;
}

export interface ApiResult<T> {
  data: T;
  meta: ResponseMeta;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, API_URL);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Core request function.
 *
 * Deliberately returns `{ data, meta }` rather than just data: pagination,
 * facets, timings and the cached flag all live in meta and are needed by the
 * UI.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const { body, query, csrfToken, headers, next, cache, ...rest } = options;

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (csrfToken) requestHeaders.set('X-CSRF-Token', csrfToken);

  const init: RequestInit & { next?: RequestOptions['next'] } = {
    ...rest,
    headers: requestHeaders,
    // Send the session cookie. Harmless on the server, where fetch ignores it
    // and cookies are forwarded explicitly by serverFetch().
    credentials: 'include',
  };

  if (body !== undefined) init.body = JSON.stringify(body);
  if (next) init.next = next;
  if (cache) init.cache = cache;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch {
    // A transport failure is not an HTTP status; surface it as a 503 so the UI
    // renders "service unavailable" rather than an unhandled exception.
    throw new ApiError('NETWORK_ERROR', 'Could not reach the APIHub API. Is it running?', 503);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = payload as ErrorEnvelope | null;
    const error = envelope?.error;

    throw new ApiError(
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error?.requestId,
      error?.details,
      error?.retryAfter,
    );
  }

  const envelope = payload as SuccessEnvelope<T>;
  return { data: envelope.data, meta: envelope.meta };
}

/** Convenience wrappers. */
export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),

  delete: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * Swallow a 404 into null.
 *
 * Lets a page distinguish "no such API" (render notFound()) from "the API is
 * broken" (let the error boundary handle it) without try/catch at every site.
 */
export async function tryGet<T>(
  path: string,
  options?: RequestOptions,
): Promise<ApiResult<T> | null> {
  try {
    return await api.get<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

export { API_URL };
