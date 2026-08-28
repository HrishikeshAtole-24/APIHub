/**
 * LRU cache with O(1) get and put.
 *
 * Where APIHub uses it (report 21):
 *  - In-memory L1 cache in front of Redis inside the API process.
 *  - The whole cache layer when REDIS_URL is not configured.
 *  - Per-worker memoisation of SSRF DNS resolution results.
 *
 * Implementation
 * --------------
 * A hash map for O(1) lookup plus an intrusive doubly linked list for O(1)
 * recency reordering. The list head is the most-recently-used entry and the
 * tail is the eviction candidate.
 *
 * JavaScript's `Map` preserves insertion order, so an LRU can be faked with
 * delete+set. That is O(1) amortised too, but it allocates on every touch and
 * hides the data structure being demonstrated, so the list is explicit here.
 */

interface Node<K, V> {
  key: K;
  value: V;
  /** Absolute epoch-ms expiry, or 0 when the entry never expires. */
  expiresAt: number;
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

export interface LruOptions {
  /** Maximum number of entries retained before eviction. */
  maxSize: number;
  /** Default time-to-live in milliseconds. 0 disables expiry. */
  ttlMs?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export interface LruStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  hitRate: number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, Node<K, V>>();
  private head: Node<K, V> | null = null;
  private tail: Node<K, V> | null = null;

  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: LruOptions) {
    if (options.maxSize <= 0) throw new RangeError('LruCache maxSize must be > 0');
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.map.size;
  }

  /** O(1). Returns undefined on miss or expiry, and promotes on hit. */
  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      this.misses += 1;
      return undefined;
    }
    if (this.isExpired(node)) {
      this.removeNode(node);
      this.map.delete(key);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }
    this.moveToFront(node);
    this.hits += 1;
    return node.value;
  }

  /** O(1). Membership test that respects expiry but does NOT affect recency. */
  has(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    if (this.isExpired(node)) {
      this.removeNode(node);
      this.map.delete(key);
      this.expirations += 1;
      return false;
    }
    return true;
  }

  /** O(1). Inserts or updates, evicting the least-recently-used entry if full. */
  put(key: K, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.ttlMs;
    const expiresAt = ttl > 0 ? this.now() + ttl : 0;

    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.moveToFront(existing);
      return;
    }

    const node: Node<K, V> = { key, value, expiresAt, prev: null, next: null };
    this.map.set(key, node);
    this.addToFront(node);

    if (this.map.size > this.maxSize) this.evict();
  }

  /** O(1). */
  delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.removeNode(node);
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /** Drop every expired entry. O(n); call from a periodic sweep, not a hot path. */
  prune(): number {
    let removed = 0;
    for (const node of [...this.map.values()]) {
      if (this.isExpired(node)) {
        this.removeNode(node);
        this.map.delete(node.key);
        removed += 1;
      }
    }
    this.expirations += removed;
    return removed;
  }

  /** Keys ordered most-recently-used first. Primarily a debugging/testing aid. */
  keys(): K[] {
    const out: K[] = [];
    for (let n = this.head; n !== null; n = n.next) out.push(n.key);
    return out;
  }

  stats(): LruStats {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  // ── internals ───────────────────────────────────────────────

  private isExpired(node: Node<K, V>): boolean {
    return node.expiresAt !== 0 && node.expiresAt <= this.now();
  }

  private addToFront(node: Node<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: Node<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;

    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;

    node.prev = null;
    node.next = null;
  }

  private moveToFront(node: Node<K, V>): void {
    if (this.head === node) return;
    this.removeNode(node);
    this.addToFront(node);
  }

  private evict(): void {
    if (!this.tail) return;
    const victim = this.tail;
    this.removeNode(victim);
    this.map.delete(victim.key);
    this.evictions += 1;
  }
}
