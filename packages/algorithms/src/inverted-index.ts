/**
 * In-memory inverted index with BM25 ranking (report 21, "Inverted Index:
 * search term -> API IDs, near O(k) retrieval + ranking").
 *
 * Why this exists alongside PostgreSQL full-text search
 * ----------------------------------------------------
 * PostgreSQL FTS is the production search path (report 15.1): it is
 * transactional, indexed with GIN and survives restarts. This structure is the
 * in-process complement used for:
 *   - instant autocomplete / typeahead over a small hot working set,
 *   - offline ranking experiments and regression tests where a real database
 *     would make the tests slow and non-deterministic,
 *   - the degraded search path when the database is unreachable (report 35).
 *
 * BM25 over naive TF-IDF
 * ----------------------
 * TF-IDF grows without bound as a term repeats. BM25 saturates term frequency
 * (k1) and normalises by document length (b), which matters here because API
 * descriptions vary from one line to several paragraphs.
 *
 *   idf(t)   = ln(1 + (N - df + 0.5) / (df + 0.5))
 *   score(t) = idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len/avgLen))
 */
import { analyze, type AnalyzeOptions } from './text.js';
import { topK, type Scored } from './top-k.js';

/** One field of a document, with the weight its matches carry. */
export interface IndexedField {
  value: string;
  /** Relative importance. Name matches should dominate description matches. */
  weight: number;
}

export interface IndexDocument<T = unknown> {
  id: string;
  fields: IndexedField[];
  /** Arbitrary payload returned with search hits. */
  payload?: T;
  /** Multiplier applied after BM25, e.g. popularity or reliability. */
  boost?: number;
}

interface Posting {
  /** Weighted term frequency within the document. */
  frequency: number;
}

interface StoredDocument<T> {
  id: string;
  length: number;
  boost: number;
  /** Terms this document contributed, so removal is O(terms) not O(vocabulary). */
  terms: string[];
  payload?: T;
}

export interface SearchHit<T> {
  id: string;
  score: number;
  payload?: T;
  /** Query terms that actually matched, for "why did this match?" UI. */
  matchedTerms: string[];
}

export interface InvertedIndexOptions extends AnalyzeOptions {
  /** Term-frequency saturation. Standard range 1.2 - 2.0. */
  k1?: number;
  /** Length normalisation strength, 0 (off) to 1 (full). */
  b?: number;
}

export class InvertedIndex<T = unknown> {
  /** term -> (docId -> posting). The inverted index proper. */
  private readonly postings = new Map<string, Map<string, Posting>>();
  private readonly documents = new Map<string, StoredDocument<T>>();

  private totalLength = 0;
  private readonly k1: number;
  private readonly b: number;
  private readonly analyzeOptions: AnalyzeOptions;

  constructor(options: InvertedIndexOptions = {}) {
    const { k1 = 1.5, b = 0.75, ...analyzeOptions } = options;
    this.k1 = k1;
    this.b = b;
    this.analyzeOptions = analyzeOptions;
  }

  get size(): number {
    return this.documents.size;
  }

  get termCount(): number {
    return this.postings.size;
  }

  /** Mean document length, used by BM25 length normalisation. */
  private get averageLength(): number {
    return this.documents.size === 0 ? 0 : this.totalLength / this.documents.size;
  }

  /**
   * Insert or replace a document. Re-adding the same id is safe: the previous
   * postings are removed first, which keeps ingestion idempotent (report 16.3).
   */
  add(document: IndexDocument<T>): void {
    this.remove(document.id);

    const frequencies = new Map<string, number>();
    let length = 0;

    for (const field of document.fields) {
      const terms = analyze(field.value, this.analyzeOptions);
      for (const term of terms) {
        frequencies.set(term, (frequencies.get(term) ?? 0) + field.weight);
        length += field.weight;
      }
    }

    for (const [term, frequency] of frequencies) {
      let bucket = this.postings.get(term);
      if (!bucket) {
        bucket = new Map<string, Posting>();
        this.postings.set(term, bucket);
      }
      bucket.set(document.id, { frequency });
    }

    const stored: StoredDocument<T> = {
      id: document.id,
      length,
      boost: document.boost ?? 1,
      terms: [...frequencies.keys()],
    };
    if (document.payload !== undefined) stored.payload = document.payload;

    this.documents.set(document.id, stored);
    this.totalLength += length;
  }

  addAll(documents: readonly IndexDocument<T>[]): void {
    for (const document of documents) this.add(document);
  }

  /** Remove a document and any now-empty posting lists. O(terms in doc). */
  remove(id: string): boolean {
    const stored = this.documents.get(id);
    if (!stored) return false;

    for (const term of stored.terms) {
      const bucket = this.postings.get(term);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.postings.delete(term);
    }

    this.totalLength -= stored.length;
    return this.documents.delete(id);
  }

  clear(): void {
    this.postings.clear();
    this.documents.clear();
    this.totalLength = 0;
  }

  /** Inverse document frequency for a term. */
  private idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    if (df === 0) return 0;
    const n = this.documents.size;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Rank documents against a free-text query.
   *
   * Retrieval is union-based (OR): a document matching any query term is a
   * candidate. `requireAll` switches to intersection (AND) for precise queries.
   * Ranking then runs only over the candidate set, never the whole corpus,
   * which is the retrieval/ranking separation from report 21.2.
   */
  search(
    query: string,
    limit = 20,
    options: { requireAll?: boolean; filter?: (id: string, payload?: T) => boolean } = {},
  ): SearchHit<T>[] {
    const terms = analyze(query, this.analyzeOptions);
    if (terms.length === 0 || this.documents.size === 0) return [];

    const avgLength = this.averageLength;
    const scores = new Map<string, number>();
    const matched = new Map<string, Set<string>>();

    for (const term of terms) {
      const bucket = this.postings.get(term);
      if (!bucket) continue;

      const idf = this.idf(term);
      for (const [docId, posting] of bucket) {
        const stored = this.documents.get(docId);
        if (!stored) continue;

        const normalisation =
          avgLength === 0 ? 1 : 1 - this.b + this.b * (stored.length / avgLength);
        const contribution =
          (idf * (posting.frequency * (this.k1 + 1))) /
          (posting.frequency + this.k1 * normalisation);

        scores.set(docId, (scores.get(docId) ?? 0) + contribution);

        let terms_ = matched.get(docId);
        if (!terms_) {
          terms_ = new Set<string>();
          matched.set(docId, terms_);
        }
        terms_.add(term);
      }
    }

    const candidates: Scored<StoredDocument<T>>[] = [];
    for (const [docId, rawScore] of scores) {
      const stored = this.documents.get(docId);
      if (!stored) continue;
      if (options.requireAll && (matched.get(docId)?.size ?? 0) < terms.length) continue;
      if (options.filter && !options.filter(docId, stored.payload)) continue;
      candidates.push({ item: stored, score: rawScore * stored.boost });
    }

    return topK(candidates, limit, (c) => c.score).map((wrapped) => {
      const hit: SearchHit<T> = {
        id: wrapped.item.item.id,
        score: wrapped.item.score,
        matchedTerms: [...(matched.get(wrapped.item.item.id) ?? [])],
      };
      if (wrapped.item.item.payload !== undefined) hit.payload = wrapped.item.item.payload;
      return hit;
    });
  }

  /** Document ids containing a single exact term. Near O(1). */
  postingsFor(term: string): string[] {
    return [...(this.postings.get(term)?.keys() ?? [])];
  }

  /** Diagnostics for the admin dashboard. */
  stats(): { documents: number; terms: number; averageLength: number; postings: number } {
    let postings = 0;
    for (const bucket of this.postings.values()) postings += bucket.size;
    return {
      documents: this.documents.size,
      terms: this.postings.size,
      averageLength: this.averageLength,
      postings,
    };
  }
}
