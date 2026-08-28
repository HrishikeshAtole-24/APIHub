/**
 * Server-side API access for Server Components (report 10.1).
 *
 * Two things differ from the browser:
 *
 *  1. Cookies must be forwarded explicitly. `fetch` on the server has no
 *     ambient cookie jar, so a signed-in user's Server Component render would
 *     otherwise look anonymous.
 *
 *  2. Caching is explicit. Public catalogue data is revalidated on a timer so
 *     pages are fast and SEO-friendly; anything user-specific is marked
 *     no-store so one user's data can never be served to another.
 */
import 'server-only';

import { cookies } from 'next/headers';

import { api, tryGet, type ApiResult, type RequestOptions } from './api-client';

/** Forward the browser's cookies to the API for this render. */
async function forwardedHeaders(): Promise<HeadersInit> {
  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');

  return cookieHeader ? { cookie: cookieHeader } : {};
}

/**
 * Fetch public data that may be cached.
 *
 * @param revalidateSeconds How long Next may serve a cached render.
 */
export async function fetchPublic<T>(
  path: string,
  options: RequestOptions & { revalidateSeconds?: number } = {},
): Promise<ApiResult<T>> {
  const { revalidateSeconds = 60, ...rest } = options;
  return api.get<T>(path, { ...rest, next: { revalidate: revalidateSeconds } });
}

/** Public fetch that returns null instead of throwing on 404. */
export async function fetchPublicOrNull<T>(
  path: string,
  options: RequestOptions & { revalidateSeconds?: number } = {},
): Promise<ApiResult<T> | null> {
  const { revalidateSeconds = 60, ...rest } = options;
  return tryGet<T>(path, { ...rest, next: { revalidate: revalidateSeconds } });
}

/**
 * Fetch data scoped to the signed-in user.
 *
 * Always uncached: a cached personalised response is a data leak.
 */
export async function fetchPrivate<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  return api.get<T>(path, {
    ...options,
    headers: { ...(await forwardedHeaders()), ...(options.headers as Record<string, string>) },
    cache: 'no-store',
  });
}

export async function fetchPrivateOrNull<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T> | null> {
  try {
    return await fetchPrivate<T>(path, options);
  } catch {
    // An expired session or an unreachable API must not blank a public page;
    // the caller renders the signed-out variant instead.
    return null;
  }
}

/**
 * Public fetch that yields null instead of throwing when the API is
 * unreachable.
 *
 * Two reasons this exists:
 *
 *  1. BUILD. Static prerendering runs without the API necessarily being up.
 *     A page that throws would fail the whole build, coupling the frontend
 *     deploy to backend availability.
 *
 *  2. RUNTIME. Report 35 requires the platform to "serve bounded cached public
 *     pages" when a dependency is down. A section that cannot load should
 *     degrade to a placeholder, not blank the page.
 *
 * Use this for supplementary sections. A page whose entire purpose is one
 * resource should still use fetchPublic and let the error boundary handle it.
 */
export async function fetchPublicSafe<T>(
  path: string,
  options: RequestOptions & { revalidateSeconds?: number } = {},
): Promise<ApiResult<T> | null> {
  try {
    return await fetchPublic<T>(path, options);
  } catch {
    return null;
  }
}
