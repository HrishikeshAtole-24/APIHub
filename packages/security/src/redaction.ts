/**
 * Secret redaction (report 20.1 "Credential leakage: API keys appear in logs").
 *
 * Applied at every boundary where user-influenced data could be persisted or
 * logged: playground request logging, health probe records, audit logs and
 * error reporting.
 */
import { REDACTED, SENSITIVE_HEADERS, SENSITIVE_QUERY_PARAMS } from '@apihub/config';

/** Redact known-sensitive headers. Case-insensitive; preserves ordering. */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const flat = Array.isArray(value) ? value.join(', ') : value;
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : flat;
  }
  return out;
}

/**
 * Strip credentials from a URL: userinfo, and any query parameter whose name
 * looks like a secret. Returns the original string when it cannot be parsed,
 * with userinfo removed by regex as a fallback.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/\/\/[^@/]+@/, '//');
  }
}

/**
 * Patterns for secrets that appear in free-form text (response bodies, error
 * messages). Conservative by design: over-redacting a body makes the playground
 * useless, so only high-confidence, well-known token shapes are matched.
 */
const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, label: 'bearer token' },
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, label: 'secret key' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws access key' },
  { pattern: /\bghp_[A-Za-z0-9]{30,}\b/g, label: 'github token' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack token' },
  // JWTs: three base64url segments.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: 'jwt' },
];

/** Replace recognisable secrets inside arbitrary text. */
export function redactText(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** True when a string looks like it contains a credential. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * Produce a log-safe summary of an outbound request.
 * This is the ONLY shape the playground is permitted to log.
 */
export function summarizeRequestForLog(input: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodySize?: number;
}): Record<string, unknown> {
  return {
    method: input.method,
    url: redactUrl(input.url),
    headerNames: Object.keys(input.headers).sort(),
    bodySize: input.bodySize ?? 0,
  };
}
