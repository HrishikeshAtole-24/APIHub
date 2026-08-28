/**
 * Vector maths for the semantic layer (report 21 "Cosine Similarity", 26.4
 * "pgvector on Neon").
 *
 * Production semantic search runs inside PostgreSQL via pgvector, which does
 * the ANN work in the database. These helpers cover the parts that live in
 * application code:
 *   - normalising embeddings before storage,
 *   - re-ranking a small candidate set in memory,
 *   - a dependency-free TF-IDF fallback so "related APIs" still works when no
 *     embedding provider is configured (report 26.1: AI is an augmentation,
 *     never a hard dependency).
 */

export type Vector = readonly number[] | Float32Array;

/** Euclidean (L2) norm. */
export function magnitude(v: Vector): number {
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) {
    const value = v[i] as number;
    sum += value * value;
  }
  return Math.sqrt(sum);
}

export function dot(a: Vector, b: Vector): number {
  if (a.length !== b.length) {
    throw new RangeError(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

/**
 * Cosine similarity in [-1, 1]; for non-negative vectors, [0, 1].
 * O(d) per comparison.
 */
export function cosineSimilarity(a: Vector, b: Vector): number {
  const denominator = magnitude(a) * magnitude(b);
  if (denominator === 0) return 0;
  return dot(a, b) / denominator;
}

/**
 * Cosine similarity for vectors already L2-normalised. Skips both magnitude
 * computations, so it is roughly 3x faster. Store embeddings normalised and
 * this becomes the hot path.
 */
export function cosineSimilarityNormalized(a: Vector, b: Vector): number {
  return dot(a, b);
}

/** Return a unit-length copy. Zero vectors are returned unchanged. */
export function normalizeVector(v: Vector): number[] {
  const norm = magnitude(v);
  if (norm === 0) return Array.from(v as ArrayLike<number>);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] as number) / norm;
  return out;
}

export function euclideanDistance(a: Vector, b: Vector): number {
  if (a.length !== b.length) {
    throw new RangeError(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = (a[i] as number) - (b[i] as number);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Jaccard similarity over sets: |A intersect B| / |A union B|.
 * Used for tag/category overlap, where cosine over sparse one-hot vectors would
 * be needless work.
 */
export function jaccardSimilarity<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of smaller) {
    if (larger.has(value)) intersection += 1;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Sparse TF-IDF fallback ────────────────────────────────────

/** Sparse vector as term -> weight. Far cheaper than a dense array for text. */
export type SparseVector = Map<string, number>;

/** Cosine similarity between two sparse vectors. O(min(|a|, |b|)). */
export function sparseCosineSimilarity(a: SparseVector, b: SparseVector): number {
  if (a.size === 0 || b.size === 0) return 0;

  // Iterate the smaller map; only shared terms contribute to the dot product.
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];

  let product = 0;
  for (const [term, weight] of smaller) {
    const other = larger.get(term);
    if (other !== undefined) product += weight * other;
  }
  if (product === 0) return 0;

  let normA = 0;
  for (const weight of a.values()) normA += weight * weight;
  let normB = 0;
  for (const weight of b.values()) normB += weight * weight;

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : product / denominator;
}

/**
 * Build TF-IDF sparse vectors for a corpus of pre-tokenised documents.
 *
 *   tf(t, d)  = count(t in d) / |d|
 *   idf(t)    = ln(N / (1 + df(t))) + 1     (smoothed, always positive)
 *
 * This gives APIHub a "related APIs" and content-based recommendation signal
 * with zero external services (report 26.1).
 */
export function buildTfIdfVectors(documents: ReadonlyMap<string, readonly string[]>): {
  vectors: Map<string, SparseVector>;
  idf: Map<string, number>;
} {
  const documentFrequency = new Map<string, number>();
  const total = documents.size;

  for (const terms of documents.values()) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, df] of documentFrequency) {
    idf.set(term, Math.log(total / (1 + df)) + 1);
  }

  const vectors = new Map<string, SparseVector>();
  for (const [id, terms] of documents) {
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);

    const vector: SparseVector = new Map();
    const length = terms.length || 1;
    for (const [term, count] of counts) {
      vector.set(term, (count / length) * (idf.get(term) ?? 1));
    }
    vectors.set(id, vector);
  }

  return { vectors, idf };
}
