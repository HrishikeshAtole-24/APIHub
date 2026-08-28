/**
 * Query parsing: user text -> PostgreSQL tsquery + implied filters.
 *
 * Two responsibilities:
 *
 *  1. SAFETY. A raw user string cannot be interpolated into `to_tsquery`:
 *     characters like `&`, `|`, `!`, `:` and `(` are operators, and malformed
 *     input raises a database error that would surface as a 500 on every
 *     mistyped search. Tokens are extracted and the query is rebuilt from them.
 *
 *  2. INTENT. "free weather api no auth" carries filters, not just terms.
 *     Extracting them (report 26.2 "intent extraction -> structured filters")
 *     turns natural phrasing into the same filters the sidebar would set, and
 *     the UI shows the user what was inferred.
 */
import { analyze } from '@apihub/algorithms';

export interface ParsedQuery {
  /** Safe tsquery string, e.g. `weather:* & forecast:*`. */
  tsquery: string;
  /** Analysed terms, for highlighting and "did you mean". */
  terms: string[];
  /** The query with filter phrases removed. */
  cleanedText: string;
  /** Filters detected in the text. */
  inferred: {
    free: boolean | null;
    noAuth: boolean | null;
    httpsOnly: boolean | null;
    corsRequired: boolean | null;
  };
}

/** Phrases that imply a filter, longest first so "no auth" wins over "auth". */
const INTENT_PATTERNS: { pattern: RegExp; apply: (into: ParsedQuery['inferred']) => void }[] = [
  { pattern: /\bno[\s-]?auth(entication)?\b/gi, apply: (i) => { i.noAuth = true; } },
  { pattern: /\bwithout\s+(an?\s+)?(api[\s-]?)?key\b/gi, apply: (i) => { i.noAuth = true; } },
  { pattern: /\bno\s+(api[\s-]?)?key\b/gi, apply: (i) => { i.noAuth = true; } },
  { pattern: /\bkeyless\b/gi, apply: (i) => { i.noAuth = true; } },
  { pattern: /\bfree\b/gi, apply: (i) => { i.free = true; } },
  { pattern: /\bno\s+cost\b/gi, apply: (i) => { i.free = true; } },
  { pattern: /\bhttps\s+only\b/gi, apply: (i) => { i.httpsOnly = true; } },
  { pattern: /\bsecure\s+only\b/gi, apply: (i) => { i.httpsOnly = true; } },
  { pattern: /\bcors\s+(enabled|support(ed)?)\b/gi, apply: (i) => { i.corsRequired = true; } },
  { pattern: /\bbrowser[\s-]?friendly\b/gi, apply: (i) => { i.corsRequired = true; } },
];

/** Noise words that add nothing to a search over an API catalogue. */
const QUERY_NOISE = new Set([
  'api', 'apis', 'endpoint', 'endpoints', 'service', 'services',
  'need', 'want', 'looking', 'find', 'get', 'give', 'show', 'best', 'good',
  'some', 'any', 'please', 'help', 'me', 'i', 'my',
]);

/**
 * Escape a token for use inside to_tsquery.
 *
 * Only lexeme characters survive. Anything else is dropped rather than escaped,
 * because tsquery has no escape syntax for its operators.
 */
function sanitizeToken(token: string): string {
  return token.replace(/[^a-z0-9]/gi, '');
}

export function parseQuery(input: string, options: { prefixMatch?: boolean } = {}): ParsedQuery {
  const { prefixMatch = true } = options;

  const inferred: ParsedQuery['inferred'] = {
    free: null,
    noAuth: null,
    httpsOnly: null,
    corsRequired: null,
  };

  // Strip intent phrases before tokenising so "free" does not also become a term.
  let cleanedText = input;
  for (const { pattern, apply } of INTENT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(cleanedText)) {
      apply(inferred);
      cleanedText = cleanedText.replace(pattern, ' ');
    }
  }

  const analysed = analyze(cleanedText).filter((term) => !QUERY_NOISE.has(term));

  // If noise removal emptied the query, fall back to the unfiltered terms
  // rather than searching for nothing (a user may genuinely search "api").
  const terms = analysed.length > 0 ? analysed : analyze(cleanedText);

  const lexemes = terms.map(sanitizeToken).filter((token) => token.length > 0);

  // AND the terms: a multi-word query should narrow, not widen. The service
  // falls back to an OR query when this returns too few results.
  const tsquery = lexemes.map((token) => (prefixMatch ? `${token}:*` : token)).join(' & ');

  return { tsquery, terms, cleanedText: cleanedText.trim(), inferred };
}

/** OR variant, used to broaden a query that returned too little. */
export function toOrQuery(parsed: ParsedQuery): string {
  const lexemes = parsed.terms.map(sanitizeToken).filter((token) => token.length > 0);
  return lexemes.map((token) => `${token}:*`).join(' | ');
}

/**
 * Wrap matched terms in <mark> for the results list.
 *
 * The input is escaped first: highlighting inserts HTML, so unescaped content
 * would be an XSS sink. Only the marker tags we add are real markup.
 */
export function highlight(text: string, terms: string[], maxLength = 220): string | null {
  if (!text || terms.length === 0) return null;

  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Match on the stem prefix so "forecasting" highlights for the term "forecast".
  const alternation = terms
    .map((term) => sanitizeToken(term))
    .filter((term) => term.length > 2)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  if (!alternation) return null;

  const matcher = new RegExp(`\\b(${alternation})\\w*`, 'gi');
  const firstMatch = matcher.exec(escaped);
  matcher.lastIndex = 0;

  // Window the snippet around the first match rather than always truncating
  // from the start, so the matched term is visible.
  let snippet = escaped;
  if (escaped.length > maxLength) {
    const start = Math.max(0, (firstMatch?.index ?? 0) - 60);
    snippet = (start > 0 ? '...' : '') + escaped.slice(start, start + maxLength) + '...';
  }

  const marked = snippet.replace(matcher, '<mark>$&</mark>');
  return marked === snippet && !firstMatch ? null : marked;
}
