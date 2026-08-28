/**
 * Output sanitisation (report 20.1: "XSS - stored review contains script").
 *
 * Strategy: APIHub never renders user-supplied HTML. Review bodies, collection
 * names and API descriptions are rendered as plain text by React, which escapes
 * automatically. These helpers exist for the paths React does NOT cover:
 *   - text embedded into server-generated JSON-LD / meta tags,
 *   - the playground response viewer, which renders untrusted upstream bodies,
 *   - anything written into a log or an email.
 *
 * There is deliberately no "allow some HTML" mode. An allowlist sanitiser is a
 * large attack surface, and no APIHub feature requires rich text.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#47;',
};

/** Escape every character with meaning in an HTML context. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"'/]/g, (char) => HTML_ESCAPES[char] as string);
}

/**
 * Strip characters that are invisible or that reverse text direction.
 *
 * Bidirectional override characters let an attacker make a review read
 * differently than it is stored ("trojan source"), and zero-width characters
 * are used to evade moderation keyword filters.
 */
export function stripInvisibleCharacters(input: string): string {
  return (
    input
      // Zero-width spaces/joiners, bidi overrides and isolates, and the BOM.
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      // C0 and C1 control characters, keeping tab, newline and carriage return.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  );
}

/**
 * Normalise free text submitted by a user before it is stored.
 * Applied to review titles/bodies and collection names.
 */
export function sanitizeUserText(input: string, maxLength = 4000): string {
  return stripInvisibleCharacters(input)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // collapse runaway blank lines
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Make a URL safe to place in an href.
 * Only http/https survive; `javascript:`, `data:` and friends become null.
 */
export function sanitizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Drop embedded credentials so they never reach the DOM or a log.
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Escape a value for safe embedding inside a <script type="application/ld+json">
 * block. `<` must be escaped or a payload containing `</script>` breaks out.
 * U+2028/U+2029 are valid in JSON but are line terminators in JavaScript.
 */
export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029');
}

/**
 * Detect a content type that a browser might render as HTML.
 * The playground uses this to decide whether a response body may be shown in
 * an iframe preview or must stay in the read-only text viewer.
 */
export function isRenderableAsHtml(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'text/html' || type === 'application/xhtml+xml' || type === 'image/svg+xml';
}

/** Filename-safe string for downloads and export files. */
export function safeFilename(input: string, fallback = 'apihub-export'): string {
  const cleaned = stripInvisibleCharacters(input)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : fallback;
}
