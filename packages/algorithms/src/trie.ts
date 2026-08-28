/**
 * Compressed-payload trie for prefix search / autocomplete (report 21, "Trie:
 * optional prefix search/autocomplete, O(L) query").
 *
 * APIHub uses it for the search box typeahead: as the user types "weath", the
 * trie returns "weather", "weatherstack", "weather-api" in O(L + results)
 * where L is the prefix length, independent of catalogue size.
 *
 * Each node keeps the best-scoring completions beneath it, so producing the top
 * suggestions is a single node lookup rather than a subtree walk. That costs
 * memory proportional to `maxSuggestionsPerNode` and is refreshed on insert.
 */

export interface TrieEntry<T> {
  /** The term as it should be displayed to the user. */
  term: string;
  /** Higher ranks first among completions sharing a prefix. */
  score: number;
  payload?: T;
}

interface TrieNode<T> {
  children: Map<string, TrieNode<T>>;
  /** Entry terminating exactly at this node, if any. */
  terminal: TrieEntry<T> | null;
  /** Cached best completions in this subtree, sorted by score descending. */
  best: TrieEntry<T>[];
}

function createNode<T>(): TrieNode<T> {
  return { children: new Map(), terminal: null, best: [] };
}

export class Trie<T = unknown> {
  private readonly root = createNode<T>();
  private count = 0;

  constructor(private readonly maxSuggestionsPerNode = 10) {}

  get size(): number {
    return this.count;
  }

  /**
   * Insert a term. Re-inserting the same term updates its score and payload.
   * Time O(L * maxSuggestionsPerNode) because every node on the path refreshes
   * its cached completions.
   */
  insert(entry: TrieEntry<T>): void {
    const key = entry.term.toLowerCase().trim();
    if (key.length === 0) return;

    const path: TrieNode<T>[] = [this.root];
    let node = this.root;

    for (const char of key) {
      let next = node.children.get(char);
      if (!next) {
        next = createNode<T>();
        node.children.set(char, next);
      }
      node = next;
      path.push(node);
    }

    if (!node.terminal) this.count += 1;
    node.terminal = entry;

    for (const visited of path) this.mergeBest(visited, entry);
  }

  insertAll(entries: readonly TrieEntry<T>[]): void {
    for (const entry of entries) this.insert(entry);
  }

  /** Exact-match lookup. O(L). */
  get(term: string): TrieEntry<T> | null {
    return this.descend(term.toLowerCase().trim())?.terminal ?? null;
  }

  has(term: string): boolean {
    return this.get(term) !== null;
  }

  /**
   * Top completions for a prefix, best score first. O(L) thanks to the cached
   * per-node suggestion list.
   */
  suggest(prefix: string, limit = 10): TrieEntry<T>[] {
    const key = prefix.toLowerCase().trim();
    if (key.length === 0) return this.root.best.slice(0, limit);

    const node = this.descend(key);
    return node ? node.best.slice(0, limit) : [];
  }

  /**
   * Every term under a prefix, via DFS. Unbounded, so it is a maintenance /
   * export helper rather than a request-path call.
   */
  collect(prefix: string, limit = 100): TrieEntry<T>[] {
    const node = this.descend(prefix.toLowerCase().trim());
    if (!node) return [];

    const out: TrieEntry<T>[] = [];
    const stack: TrieNode<T>[] = [node];

    while (stack.length > 0 && out.length < limit) {
      const current = stack.pop() as TrieNode<T>;
      if (current.terminal) out.push(current.terminal);
      for (const child of current.children.values()) stack.push(child);
    }
    return out.sort((a, b) => b.score - a.score);
  }

  clear(): void {
    this.root.children.clear();
    this.root.terminal = null;
    this.root.best = [];
    this.count = 0;
  }

  // ── internals ───────────────────────────────────────────────

  private descend(key: string): TrieNode<T> | null {
    let node: TrieNode<T> = this.root;
    for (const char of key) {
      const next = node.children.get(char);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** Insert `entry` into a node's cached best-list, keeping it sorted and bounded. */
  private mergeBest(node: TrieNode<T>, entry: TrieEntry<T>): void {
    const existing = node.best.findIndex((e) => e.term === entry.term);
    if (existing !== -1) node.best.splice(existing, 1);

    // Linear insertion is fine: the list is capped at maxSuggestionsPerNode.
    let index = node.best.findIndex((e) => e.score < entry.score);
    if (index === -1) index = node.best.length;

    if (index < this.maxSuggestionsPerNode) {
      node.best.splice(index, 0, entry);
      if (node.best.length > this.maxSuggestionsPerNode) node.best.pop();
    }
  }
}
