/**
 * Array-backed binary heap and a priority queue built on top of it.
 *
 * Where APIHub uses it (report 21):
 *  - The health scheduler orders probes by priority so popular or recently
 *    failing APIs are re-checked before the long tail.
 *  - Top-K search ranking (see top-k.ts).
 *
 * Complexity: push O(log n), pop O(log n), peek O(1), heapify O(n).
 */

export type Comparator<T> = (a: T, b: T) => number;

export class BinaryHeap<T> {
  private readonly items: T[] = [];

  /**
   * @param compare Returns < 0 when `a` should sit closer to the root.
   *                Min-heap: (a, b) => a - b.  Max-heap: (a, b) => b - a.
   * @param initial Optional seed array, heapified in O(n).
   */
  constructor(
    private readonly compare: Comparator<T>,
    initial: readonly T[] = [],
  ) {
    if (initial.length > 0) {
      this.items = [...initial];
      // Floyd's build-heap: sift down from the last internal node. O(n), not O(n log n).
      for (let i = (this.items.length >> 1) - 1; i >= 0; i -= 1) this.siftDown(i);
    }
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** O(1). */
  peek(): T | undefined {
    return this.items[0];
  }

  /** O(log n). */
  push(value: T): void {
    this.items.push(value);
    this.siftUp(this.items.length - 1);
  }

  /** O(log n). */
  pop(): T | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;

    const last = this.items.pop() as T;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /**
   * Replace the root and re-heapify in a single O(log n) pass.
   * Cheaper than pop() + push() and the core of bounded Top-K.
   */
  replaceTop(value: T): T | undefined {
    const top = this.items[0];
    if (top === undefined) {
      this.push(value);
      return undefined;
    }
    this.items[0] = value;
    this.siftDown(0);
    return top;
  }

  /** O(n log n). Drains the heap into a sorted array. */
  drainSorted(): T[] {
    const out: T[] = [];
    while (!this.isEmpty) out.push(this.pop() as T);
    return out;
  }

  /** Non-destructive snapshot in internal (heap) order. */
  toArray(): T[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }

  // ── internals ───────────────────────────────────────────────

  private siftUp(start: number): void {
    let index = start;
    const value = this.items[index] as T;

    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentValue = this.items[parent] as T;
      if (this.compare(value, parentValue) >= 0) break;
      this.items[index] = parentValue;
      index = parent;
    }
    this.items[index] = value;
  }

  private siftDown(start: number): void {
    let index = start;
    const length = this.items.length;
    const value = this.items[index] as T;

    for (;;) {
      const left = index * 2 + 1;
      if (left >= length) break;

      const right = left + 1;
      let child = left;
      if (right < length && this.compare(this.items[right] as T, this.items[left] as T) < 0) {
        child = right;
      }

      if (this.compare(this.items[child] as T, value) >= 0) break;
      this.items[index] = this.items[child] as T;
      index = child;
    }
    this.items[index] = value;
  }
}

export interface PriorityEntry<T> {
  value: T;
  /** Lower number = handled sooner. */
  priority: number;
  /** Monotonic tiebreaker guaranteeing FIFO order within one priority band. */
  sequence: number;
}

/**
 * Stable min-priority queue.
 *
 * Plain heaps are not stable: two entries with equal priority can come out in
 * arbitrary order. The health scheduler needs fairness, so a monotonically
 * increasing sequence number breaks ties in insertion order.
 */
export class PriorityQueue<T> {
  private readonly heap: BinaryHeap<PriorityEntry<T>>;
  private sequence = 0;

  constructor() {
    this.heap = new BinaryHeap<PriorityEntry<T>>((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.sequence - b.sequence,
    );
  }

  get size(): number {
    return this.heap.size;
  }

  get isEmpty(): boolean {
    return this.heap.isEmpty;
  }

  enqueue(value: T, priority: number): void {
    this.sequence += 1;
    this.heap.push({ value, priority, sequence: this.sequence });
  }

  dequeue(): T | undefined {
    return this.heap.pop()?.value;
  }

  peek(): T | undefined {
    return this.heap.peek()?.value;
  }

  /** Pop up to `count` entries. Used to hand a bounded batch to the probe pool. */
  dequeueBatch(count: number): T[] {
    const out: T[] = [];
    for (let i = 0; i < count && !this.isEmpty; i += 1) out.push(this.dequeue() as T);
    return out;
  }

  clear(): void {
    this.heap.clear();
    this.sequence = 0;
  }
}
