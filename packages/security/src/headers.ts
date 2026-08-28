/**
 * Security response headers (report 20.3).
 *
 * These are applied by the API to its own responses. The Next.js app sets an
 * equivalent set in its own middleware, since the two are served from
 * different origins.
 */

export interface SecurityHeaderOptions {
  /** Enable HSTS. Only meaningful over HTTPS; must be off for local http. */
  enableHsts: boolean;
  /** Extra origins permitted to load frames/scripts, e.g. a docs CDN. */
  extraConnectSources?: string[];
  /** Report-only mode lets a policy be validated before it is enforced. */
  cspReportOnly?: boolean;
}

/**
 * Content-Security-Policy for JSON API responses.
 *
 * An API returning JSON should never execute anything, so the policy is
 * maximally restrictive: `default-src 'none'` denies every resource type that
 * is not explicitly re-enabled. This matters because a browser that is tricked
 * into rendering an API response as HTML then has no capability to abuse.
 */
export function buildApiCsp(): string {
  return [
    "default-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox",
  ].join('; ');
}

/**
 * Content-Security-Policy for the web application.
 *
 * `'unsafe-inline'` is present for styles only. Next.js injects inline style
 * attributes during hydration, and a nonce-based style policy would require
 * disabling that. Scripts do NOT get 'unsafe-inline'.
 */
export function buildWebCsp(nonce: string, options: SecurityHeaderOptions): string {
  const connect = ["'self'", ...(options.extraConnectSources ?? [])].join(' ');

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** Build the full header set for an API response. */
export function buildSecurityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    // Stop browsers guessing a content type and rendering JSON as HTML.
    'X-Content-Type-Options': 'nosniff',
    // Legacy but harmless; modern protection comes from CSP frame-ancestors.
    'X-Frame-Options': 'DENY',
    // Do not leak the full URL (which may contain a search query) cross-origin.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Deny powerful browser features outright; the API needs none of them.
    'Permissions-Policy': [
      'accelerometer=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
      'interest-cohort=()',
    ].join(', '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
    'X-Permitted-Cross-Domain-Policies': 'none',
    // Do not advertise the framework.
    'X-Powered-By': '',
  };

  const cspHeader = options.cspReportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  headers[cspHeader] = buildApiCsp();

  if (options.enableHsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
  }

  return headers;
}

/**
 * Headers that must accompany any response containing user-specific data, so
 * no shared cache (CDN, proxy) ever stores one user's data for another.
 */
export const PRIVATE_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie, Authorization',
};

/** Cache headers for public, cacheable catalogue responses. */
export function publicCacheHeaders(maxAgeSeconds: number, staleSeconds = 60): Record<string, string> {
  return {
    'Cache-Control': `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleSeconds}`,
    Vary: 'Accept-Encoding',
  };
}
