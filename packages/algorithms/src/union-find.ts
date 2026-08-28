/**
 * Disjoint Set Union with path compression and union by rank (report 21,
 * "Union-Find: optional clustering/dedup experimentation, near O(alpha(n))").
 *
 * Ingestion use case
 * ------------------
 * Upstream data contains the same API under several spellings:
 *   "OpenWeatherMap", "Open Weather Map", "openweathermap.org"
 *
 * Pairwise similarity gives us edges between likely-duplicate records. Union-Find
 * turns those pairwise edges into transitive clusters in near-linear time: if A
 * matches B and B matches C, all three land in one cluster without us having to
 * compare A with C.
 *
 * Per report 16.2 the resulting clusters are a REVIEW signal for an operator,
 * never an automatic destructive merge.
 */

export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();
  private componentCount = 0;

  constructor(initial: readonly string[] = []) {
    for (const id of initial) this.makeSet(id);
  }

  /** Number of disjoint components currently tracked. */
  get components(): number {
    return this.componentCount;
  }

  get size(): number {
    return this.parent.size;
  }

  /** Register an element as its own singleton set. Idempotent. */
  makeSet(id: string): void {
    if (this.parent.has(id)) return;
    this.parent.set(id, id);
    this.rank.set(id, 0);
    this.componentCount += 1;
  }

  /**
   * Find the representative of an element's set, compressing the path on the
   * way back up. Iterative to avoid blowing the stack on long chains.
   */
  find(id: string): string {
    this.makeSet(id);

    let root = id;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }

    // Path compression: point every node on the path directly at the root.
    let current = id;
    while (current !== root) {
      const next = this.parent.get(current) as string;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  /** Merge two sets. Returns false when they were already the same set. */
  union(a: string, b: string): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;

    // Union by rank keeps trees shallow.
    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;

    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }

    this.componentCount -= 1;
    return true;
  }

  connected(a: string, b: string): boolean {
    return this.find(a) === this.find(b);
  }

  /** All clusters, keyed by representative. Singletons included. */
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const bucket = out.get(root);
      if (bucket) bucket.push(id);
      else out.set(root, [id]);
    }
    return out;
  }

  /** Only the clusters with more than one member, i.e. actual duplicate candidates. */
  duplicateClusters(): string[][] {
    return [...this.groups().values()].filter((group) => group.length > 1);
  }
}

/**
 * Build duplicate clusters from a candidate list using a similarity predicate.
 *
 * `blockingKey` is the important part: comparing every pair is O(n^2), which is
 * unacceptable for thousands of records. Blocking partitions candidates into
 * buckets that could plausibly match (e.g. first letter of the normalised name,
 * or the registrable domain) and only compares within a bucket.
 */
export function clusterDuplicates<T>(
  items: readonly T[],
  identify: (item: T) => string,
  blockingKey: (item: T) => string,
  isSimilar: (a: T, b: T) => boolean,
): string[][] {
  const dsu = new UnionFind(items.map(identify));

  const blocks = new Map<string, T[]>();
  for (const item of items) {
    const key = blockingKey(item);
    const bucket = blocks.get(key);
    if (bucket) bucket.push(item);
    else blocks.set(key, [item]);
  }

  for (const bucket of blocks.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i] as T;
        const b = bucket[j] as T;
        if (isSimilar(a, b)) dsu.union(identify(a), identify(b));
      }
    }
  }

  return dsu.duplicateClusters();
}
