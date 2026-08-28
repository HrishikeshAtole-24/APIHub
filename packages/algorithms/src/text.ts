/**
 * Text normalisation shared by the inverted index, the trie and the
 * TF-IDF/vector layer.
 *
 * Deliberately dependency-free: a hand-written analyser is small, fast, fully
 * testable, and keeps the search pipeline explainable. It mirrors what
 * PostgreSQL's `to_tsvector('english', ...)` does closely enough that the
 * in-process index and the database index rank consistently.
 */

/**
 * English stop words. Kept short on purpose: aggressive stop-word removal hurts
 * a technical catalogue where terms like "no" (as in "no auth") carry meaning.
 */
export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'has', 'have', 'he', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'she',
  'that', 'the', 'their', 'there', 'these', 'they', 'this', 'to', 'was', 'were',
  'will', 'with', 'you', 'your',
]);

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalize(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Split text into candidate terms.
 *
 * Keeps `.` `-` `+` `#` inside tokens so that "node.js", "oauth2", "c#",
 * "real-time" and "c++" survive as single meaningful terms.
 */
export function tokenize(input: string): string[] {
  const cleaned = normalize(input).replace(/[^a-z0-9.+#-]+/g, ' ');
  const out: string[] = [];

  for (const raw of cleaned.split(/\s+/)) {
    // Strip only leading/trailing dots and dashes. `#` and `+` must survive at
    // the end of a token so that "c#" and "c++" stay intact.
    const token = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (token.length === 0) continue;
    out.push(token);
  }
  return out;
}

/**
 * A conservative Porter-style suffix stripper.
 *
 * Full Porter stemming over-stems technical vocabulary ("apis" -> "api" is
 * wanted, but "https" -> "http" is actively harmful). This handles only the
 * high-value, low-risk cases.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  // Protect known technical terms from suffix stripping.
  if (/^(https|dns|css|js|rss|sms|aws|gps|ios|os|tls|ssl|xss)$/.test(token)) return token;

  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('ss')) return token;
  // Depluralise, but leave Latinate singulars alone: "status"/"bonus" (-us) and
  // "analysis"/"basis" (-sis). Note -is alone is too broad; it would wrongly
  // protect "apis", which must stem to "api".
  if (token.endsWith('s') && !token.endsWith('us') && !token.endsWith('sis')) {
    return token.slice(0, -1);
  }
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  return token;
}

export interface AnalyzeOptions {
  /** Remove stop words. Default true. */
  removeStopWords?: boolean;
  /** Apply the suffix stripper. Default true. */
  applyStemming?: boolean;
  /** Discard tokens shorter than this. Default 2. */
  minLength?: number;
}

/** Full analysis pipeline: normalize -> tokenize -> filter -> stem. */
export function analyze(input: string, options: AnalyzeOptions = {}): string[] {
  const { removeStopWords = true, applyStemming = true, minLength = 2 } = options;

  const out: string[] = [];
  for (const token of tokenize(input)) {
    if (token.length < minLength) continue;
    if (removeStopWords && STOP_WORDS.has(token)) continue;
    out.push(applyStemming ? stem(token) : token);
  }
  return out;
}

/** Unique analysed terms, order preserved. */
export function analyzeUnique(input: string, options?: AnalyzeOptions): string[] {
  return [...new Set(analyze(input, options))];
}

/**
 * URL-safe slug. Used for canonical API identifiers, so it must be stable:
 * changing this function changes every slug and breaks existing links.
 */
export function slugify(input: string): string {
  const base = normalize(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : 'untitled';
}

/**
 * Levenshtein edit distance with the classic two-row rolling optimisation and
 * an early exit once the best possible distance exceeds `maxDistance`.
 *
 * Used for "did you mean?" suggestions and as a REVIEW signal during ingestion
 * deduplication. Per report 16.2 it must never trigger an automatic merge.
 *
 * Time O(m*n), space O(min(m, n)).
 */
export function editDistance(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  // Iterate over the shorter string to keep the rolling rows small.
  let source = a;
  let target = b;
  if (source.length > target.length) [source, target] = [target, source];

  let previous = Array.from({ length: source.length + 1 }, (_, i) => i);
  let current = new Array<number>(source.length + 1);

  for (let j = 1; j <= target.length; j += 1) {
    current[0] = j;
    let rowMin = current[0] as number;

    for (let i = 1; i <= source.length; i += 1) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[i - 1] as number) + 1, // insertion
        (previous[i] as number) + 1, // deletion
        (previous[i - 1] as number) + cost, // substitution
      );
      current[i] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }

  return previous[source.length] as number;
}

/** Normalised similarity in [0, 1]. 1 means identical. */
export function similarityRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}
