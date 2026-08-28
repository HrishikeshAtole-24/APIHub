/**
 * Bounded Top-K selection (report 21.1).
 *
 * Naively you would score every candidate, sort the whole array, then slice:
 *   O(N log N) time and O(N) extra space.
 *
 * With a size-K min-heap you keep only the best K seen so far:
 *   O(N log K) time and O(K) space.
 *
 * For APIHub's search this matters because retrieval returns a few thousand
 * candidates while the page shows 24. The report's rule of "separate retrieval
 * from ranking" (15.2 / 21.2) makes this the ranking half of the pipeline.
 */
import { BinaryHeap } from './binary-heap.js';

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Select the K highest-scoring items, returned in descending score order.
 *
 * @param items    Candidate set (not mutated).
 * @param k        Number of results wanted.
 * @param scoreOf  Score function; higher is better. Called exactly once per item.
 * @param tieBreak Optional stable comparator for equal scores; < 0 means `a` first.
 */
export function topK<T>(
  items: readonly T[],
  k: number,
  scoreOf: (item: T) => number,
  tieBreak?: (a: T, b: T) => number,
): Scored<T>[] {
  if (k <= 0 || items.length === 0) return [];

  // A min-heap keyed on score: the WORST of the current best-K sits at the root,
  // so it is O(1) to decide whether a new candidate deserves a place.
  const heap = new BinaryHeap<Scored<T>>((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Invert the tiebreak: inside a min-heap the "less preferred" item must be
    // closer to the root so that it is evicted first.
    return tieBreak ? -tieBreak(a.item, b.item) : 0;
  });

  for (const item of items) {
    const score = scoreOf(item);

    if (heap.size < k) {
      heap.push({ item, score });
      continue;
    }

    const worst = heap.peek() as Scored<T>;
    if (score > worst.score || (score === worst.score && tieBreak && tieBreak(item, worst.item) < 0)) {
      // Single O(log K) pass instead of pop() + push().
      heap.replaceTop({ item, score });
    }
  }

  // Drained ascending (worst first) -> reverse for descending presentation order.
  return heap.drainSorted().reverse();
}

/**
 * Top-K over pre-scored entries. Convenience wrapper for pipelines where the
 * score was already computed by SQL or a ranking strategy.
 */
export function topKScored<T>(entries: readonly Scored<T>[], k: number): Scored<T>[] {
  return topK(entries, k, (e) => e.score).map((wrapped) => wrapped.item);
}

/**
 * Merge several already-sorted descending lists and take the global top K.
 * Used by hybrid search to fuse the lexical and semantic candidate lists
 * without concatenating and re-sorting everything.
 *
 * Complexity: O(total log L) where L is the number of lists.
 */
export function mergeTopK<T>(lists: readonly (readonly Scored<T>[])[], k: number): Scored<T>[] {
  if (k <= 0) return [];

  interface Cursor<U> {
    listIndex: number;
    itemIndex: number;
    entry: Scored<U>;
  }

  // Max-heap across list heads.
  const heap = new BinaryHeap<Cursor<T>>((a, b) => b.entry.score - a.entry.score);

  lists.forEach((list, listIndex) => {
    const entry = list[0];
    if (entry) heap.push({ listIndex, itemIndex: 0, entry });
  });

  const out: Scored<T>[] = [];
  while (out.length < k && !heap.isEmpty) {
    const cursor = heap.pop() as Cursor<T>;
    out.push(cursor.entry);

    const list = lists[cursor.listIndex];
    const next = list?.[cursor.itemIndex + 1];
    if (next) {
      heap.push({ listIndex: cursor.listIndex, itemIndex: cursor.itemIndex + 1, entry: next });
    }
  }
  return out;
}

/**
 * Reciprocal Rank Fusion: combine ranked lists without needing their scores to
 * live on a comparable scale. This is how APIHub fuses BM25-style lexical hits
 * with cosine-similarity semantic hits (report 15.2).
 *
 * score(d) = sum over lists of 1 / (kConstant + rank(d))
 *
 * @param kConstant Damping constant; 60 is the value from the original paper.
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  identify: (item: T) => string,
  k: number,
  kConstant = 60,
): Scored<T>[] {
  const scores = new Map<string, number>();
  const seen = new Map<string, T>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const id = identify(item);
      if (!seen.has(id)) seen.set(id, item);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (kConstant + index + 1));
    });
  }

  const merged = [...scores.entries()].map(([id, score]) => ({
    item: seen.get(id) as T,
    score,
  }));

  return topK(merged, k, (entry) => entry.score).map((wrapped) => wrapped.item);
}
