import { describe, expect, it } from 'vitest';

import { BinaryHeap, PriorityQueue } from './binary-heap.js';
import { BloomFilter } from './bloom-filter.js';
import { DirectedGraph } from './graph.js';
import { InvertedIndex } from './inverted-index.js';
import { LruCache } from './lru-cache.js';
import { RollingOutcomeWindow, SlidingWindowCounter, SlidingWindowLog } from './sliding-window.js';
import { analyze, editDistance, slugify, stem, tokenize } from './text.js';
import { TokenBucketLimiter, consume } from './token-bucket.js';
import { mergeTopK, reciprocalRankFusion, topK } from './top-k.js';
import { Trie } from './trie.js';
import { UnionFind, clusterDuplicates } from './union-find.js';
import {
  buildTfIdfVectors,
  cosineSimilarity,
  jaccardSimilarity,
  normalizeVector,
  sparseCosineSimilarity,
} from './vector.js';

// A controllable clock so every time-based test is deterministic.
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<string, number>({ maxSize: 3 });
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);

    cache.get('a'); // 'a' becomes most recent, so 'b' is now the victim
    cache.put('d', 4);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('expires entries once the TTL elapses', () => {
    const clock = fakeClock();
    const cache = new LruCache<string, string>({ maxSize: 10, ttlMs: 1000, now: clock.now });

    cache.put('key', 'value');
    expect(cache.get('key')).toBe('value');

    clock.advance(1001);
    expect(cache.get('key')).toBeUndefined();
    expect(cache.stats().expirations).toBe(1);
  });

  it('updates an existing key without growing', () => {
    const cache = new LruCache<string, number>({ maxSize: 2 });
    cache.put('a', 1);
    cache.put('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });

  it('orders keys most-recently-used first', () => {
    const cache = new LruCache<string, number>({ maxSize: 3 });
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.get('a');
    expect(cache.keys()).toEqual(['a', 'c', 'b']);
  });

  it('reports a hit rate', () => {
    const cache = new LruCache<string, number>({ maxSize: 4 });
    cache.put('a', 1);
    cache.get('a');
    cache.get('missing');
    expect(cache.stats().hitRate).toBe(0.5);
  });
});

describe('BinaryHeap', () => {
  it('behaves as a min-heap', () => {
    const heap = new BinaryHeap<number>((a, b) => a - b, [5, 3, 8, 1, 9, 2]);
    expect(heap.drainSorted()).toEqual([1, 2, 3, 5, 8, 9]);
  });

  it('behaves as a max-heap when the comparator is inverted', () => {
    const heap = new BinaryHeap<number>((a, b) => b - a);
    for (const n of [5, 3, 8, 1]) heap.push(n);
    expect(heap.pop()).toBe(8);
    expect(heap.pop()).toBe(5);
  });

  it('replaceTop is equivalent to pop followed by push', () => {
    const heap = new BinaryHeap<number>((a, b) => a - b, [1, 4, 7]);
    expect(heap.replaceTop(5)).toBe(1);
    expect(heap.drainSorted()).toEqual([4, 5, 7]);
  });

  it('heapifies a large random array correctly', () => {
    const input = Array.from({ length: 500 }, () => Math.floor(Math.random() * 1000));
    const heap = new BinaryHeap<number>((a, b) => a - b, input);
    const sorted = heap.drainSorted();
    expect(sorted).toEqual([...input].sort((a, b) => a - b));
  });
});

describe('PriorityQueue', () => {
  it('is stable within a priority band', () => {
    const queue = new PriorityQueue<string>();
    queue.enqueue('first', 1);
    queue.enqueue('second', 1);
    queue.enqueue('urgent', 0);
    queue.enqueue('third', 1);

    expect(queue.dequeue()).toBe('urgent');
    expect(queue.dequeue()).toBe('first');
    expect(queue.dequeue()).toBe('second');
    expect(queue.dequeue()).toBe('third');
  });

  it('dequeues a bounded batch', () => {
    const queue = new PriorityQueue<number>();
    for (let i = 0; i < 10; i += 1) queue.enqueue(i, i);
    expect(queue.dequeueBatch(3)).toEqual([0, 1, 2]);
    expect(queue.size).toBe(7);
  });
});

describe('topK', () => {
  it('matches a full sort but touches only K slots', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i, score: (i * 37) % 1000 }));
    const result = topK(items, 5, (item) => item.score);

    const expected = [...items].sort((a, b) => b.score - a.score).slice(0, 5);
    expect(result.map((r) => r.item.id)).toEqual(expected.map((e) => e.id));
  });

  it('returns an empty array for k <= 0', () => {
    expect(topK([1, 2, 3], 0, (n) => n)).toEqual([]);
  });

  it('handles k larger than the input', () => {
    expect(topK([3, 1, 2], 10, (n) => n).map((r) => r.item)).toEqual([3, 2, 1]);
  });

  it('applies the tiebreaker for equal scores', () => {
    const items = [
      { id: 'b', score: 1 },
      { id: 'a', score: 1 },
    ];
    const result = topK(
      items,
      2,
      (i) => i.score,
      (x, y) => x.id.localeCompare(y.id),
    );
    expect(result.map((r) => r.item.id)).toEqual(['a', 'b']);
  });

  it('merges pre-sorted lists', () => {
    const a = [
      { item: 'a1', score: 10 },
      { item: 'a2', score: 4 },
    ];
    const b = [
      { item: 'b1', score: 8 },
      { item: 'b2', score: 6 },
    ];
    expect(mergeTopK([a, b], 3).map((r) => r.item)).toEqual(['a1', 'b1', 'b2']);
  });

  it('fuses ranked lists with RRF, rewarding agreement', () => {
    const lexical = ['x', 'y', 'z'];
    const semantic = ['y', 'x', 'w'];
    const fused = reciprocalRankFusion([lexical, semantic], (s) => s, 4);
    // 'y' is 2nd and 1st, 'x' is 1st and 2nd -> both beat single-list entries.
    expect(fused.slice(0, 2).map((f) => f.item).sort()).toEqual(['x', 'y']);
  });
});

describe('text analysis', () => {
  it('keeps technical tokens intact', () => {
    expect(tokenize('Node.js and C# with real-time OAuth2')).toEqual([
      'node.js',
      'and',
      'c#',
      'with',
      'real-time',
      'oauth2',
    ]);
  });

  it('does not over-stem protected technical terms', () => {
    expect(stem('https')).toBe('https');
    expect(stem('apis')).toBe('api');
    expect(stem('categories')).toBe('category');
  });

  it('removes stop words and stems in the full pipeline', () => {
    expect(analyze('The weather APIs are for the forecasts')).toEqual([
      'weather',
      'api',
      'forecast',
    ]);
  });

  it('produces stable slugs', () => {
    expect(slugify('Open Weather Map!! (v2)')).toBe('open-weather-map-v2');
    expect(slugify('   ')).toBe('untitled');
  });

  it('computes edit distance with an early exit', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('aaaaaaaaaa', 'bbbbbbbbbb', 3)).toBeGreaterThan(3);
  });
});

describe('InvertedIndex', () => {
  const index = new InvertedIndex<{ name: string }>();

  index.addAll([
    {
      id: '1',
      fields: [
        { value: 'OpenWeather', weight: 3 },
        { value: 'Current weather and forecast data for any location', weight: 1 },
      ],
      payload: { name: 'OpenWeather' },
    },
    {
      id: '2',
      fields: [
        { value: 'CoinGecko', weight: 3 },
        { value: 'Cryptocurrency prices and market data', weight: 1 },
      ],
      payload: { name: 'CoinGecko' },
    },
    {
      id: '3',
      fields: [
        { value: 'WeatherStack', weight: 3 },
        { value: 'Real time weather information', weight: 1 },
      ],
      payload: { name: 'WeatherStack' },
    },
  ]);

  it('retrieves documents matching a term', () => {
    const hits = index.search('weather');
    expect(hits.map((h) => h.id).sort()).toEqual(['1', '3']);
  });

  it('weights name matches above description matches', () => {
    const hits = index.search('weatherstack');
    expect(hits[0]?.id).toBe('3');
  });

  it('returns nothing for unknown terms', () => {
    expect(index.search('quantum blockchain unicorn')).toEqual([]);
  });

  it('supports AND semantics', () => {
    expect(index.search('weather forecast', 10, { requireAll: true }).map((h) => h.id)).toEqual(['1']);
  });

  it('reports which terms matched', () => {
    const [hit] = index.search('cryptocurrency prices');
    expect(hit?.matchedTerms.sort()).toEqual(['cryptocurrency', 'price']);
  });

  it('is idempotent when the same id is re-added', () => {
    const local = new InvertedIndex();
    const doc = { id: 'x', fields: [{ value: 'hello world', weight: 1 }] };
    local.add(doc);
    local.add(doc);
    expect(local.size).toBe(1);
    expect(local.postingsFor('hello')).toEqual(['x']);
  });

  it('removes documents and cleans up empty postings', () => {
    const local = new InvertedIndex();
    local.add({ id: 'x', fields: [{ value: 'unique term', weight: 1 }] });
    expect(local.termCount).toBeGreaterThan(0);
    local.remove('x');
    expect(local.size).toBe(0);
    expect(local.termCount).toBe(0);
  });

  it('applies a document boost', () => {
    const local = new InvertedIndex();
    local.add({ id: 'low', fields: [{ value: 'payments api', weight: 1 }], boost: 1 });
    local.add({ id: 'high', fields: [{ value: 'payments api', weight: 1 }], boost: 5 });
    expect(local.search('payments')[0]?.id).toBe('high');
  });
});

describe('Trie', () => {
  const trie = new Trie<{ id: string }>();
  trie.insertAll([
    { term: 'weather', score: 100, payload: { id: '1' } },
    { term: 'weatherstack', score: 50, payload: { id: '2' } },
    { term: 'webhooks', score: 70, payload: { id: '3' } },
    { term: 'crypto', score: 90, payload: { id: '4' } },
  ]);

  it('suggests completions ranked by score', () => {
    expect(trie.suggest('we').map((e) => e.term)).toEqual(['weather', 'webhooks', 'weatherstack']);
  });

  it('narrows as the prefix grows', () => {
    expect(trie.suggest('weathers').map((e) => e.term)).toEqual(['weatherstack']);
  });

  it('returns nothing for an unknown prefix', () => {
    expect(trie.suggest('zzz')).toEqual([]);
  });

  it('supports exact lookup', () => {
    expect(trie.get('crypto')?.payload?.id).toBe('4');
    expect(trie.get('cryp')).toBeNull();
  });

  it('updates rather than duplicates on re-insert', () => {
    const local = new Trie();
    local.insert({ term: 'api', score: 1 });
    local.insert({ term: 'api', score: 9 });
    expect(local.size).toBe(1);
    expect(local.suggest('a')[0]?.score).toBe(9);
  });
});

describe('BloomFilter', () => {
  it('never produces false negatives', () => {
    const filter = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    const added = Array.from({ length: 1000 }, (_, i) => `fingerprint-${i}`);
    for (const value of added) filter.add(value);
    for (const value of added) expect(filter.has(value)).toBe(true);
  });

  it('keeps the false-positive rate near the target', () => {
    const filter = new BloomFilter({ expectedItems: 2000, falsePositiveRate: 0.01 });
    for (let i = 0; i < 2000; i += 1) filter.add(`present-${i}`);

    let falsePositives = 0;
    const probes = 5000;
    for (let i = 0; i < probes; i += 1) {
      if (filter.has(`absent-${i}`)) falsePositives += 1;
    }
    expect(falsePositives / probes).toBeLessThan(0.03);
  });

  it('reports whether a value was already present', () => {
    const filter = new BloomFilter({ expectedItems: 100 });
    expect(filter.addAndCheck('a')).toBe(false);
    expect(filter.addAndCheck('a')).toBe(true);
  });
});

describe('UnionFind', () => {
  it('groups transitively related elements', () => {
    const dsu = new UnionFind(['a', 'b', 'c', 'd']);
    dsu.union('a', 'b');
    dsu.union('b', 'c');

    expect(dsu.connected('a', 'c')).toBe(true);
    expect(dsu.connected('a', 'd')).toBe(false);
    expect(dsu.components).toBe(2);
  });

  it('clusters likely-duplicate API names via blocking', () => {
    const items = [
      { id: '1', name: 'openweathermap' },
      { id: '2', name: 'openweather map' },
      { id: '3', name: 'coingecko' },
    ];

    const clusters = clusterDuplicates(
      items,
      (i) => i.id,
      (i) => i.name.charAt(0),
      (a, b) => a.name.replace(/\s/g, '') === b.name.replace(/\s/g, ''),
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sort()).toEqual(['1', '2']);
  });
});

describe('vector maths', () => {
  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('normalises to unit length', () => {
    const unit = normalizeVector([3, 4]);
    expect(unit).toEqual([0.6, 0.8]);
  });

  it('computes Jaccard similarity over sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });

  it('builds TF-IDF vectors that rank a related document highest', () => {
    const corpus = new Map<string, string[]>([
      ['weather1', ['weather', 'forecast', 'temperature']],
      ['weather2', ['weather', 'forecast', 'rain']],
      ['crypto', ['bitcoin', 'price', 'exchange']],
    ]);

    const { vectors } = buildTfIdfVectors(corpus);
    const a = vectors.get('weather1');
    const b = vectors.get('weather2');
    const c = vectors.get('crypto');

    expect(sparseCosineSimilarity(a!, b!)).toBeGreaterThan(sparseCosineSimilarity(a!, c!));
    expect(sparseCosineSimilarity(a!, c!)).toBe(0);
  });
});

describe('token bucket', () => {
  it('allows a burst then throttles to the refill rate', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1, now: clock.now });

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryConsume('user-1').allowed).toBe(true);
    }

    const denied = limiter.tryConsume('user-1');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    clock.advance(1000);
    expect(limiter.tryConsume('user-1').allowed).toBe(true);
  });

  it('isolates subjects from one another', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(limiter.tryConsume('a').allowed).toBe(true);
    expect(limiter.tryConsume('b').allowed).toBe(true);
    expect(limiter.tryConsume('a').allowed).toBe(false);
  });

  it('does not spend tokens on a denied request', () => {
    const state = { tokens: 0.5, updatedAt: 0 };
    const result = consume(state, { capacity: 5, refillPerSecond: 1 }, 0, 1);
    expect(result.decision.allowed).toBe(false);
    expect(result.state.tokens).toBeCloseTo(0.5);
  });

  it('never exceeds capacity when refilling', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 10, now: clock.now });
    limiter.tryConsume('k');
    clock.advance(60_000);
    expect(limiter.peek('k')).toBe(3);
  });
});

describe('sliding windows', () => {
  it('smooths the fixed-window boundary burst', () => {
    const clock = fakeClock(60_000);
    const limiter = new SlidingWindowCounter(10, 60_000, clock.now);

    for (let i = 0; i < 10; i += 1) expect(limiter.hit('u').allowed).toBe(true);
    expect(limiter.hit('u').allowed).toBe(false);

    // Cross into the next window: a fixed window would reset to a full budget,
    // but the previous window still counts proportionally here.
    clock.advance(60_000);
    expect(limiter.hit('u').allowed).toBe(false);

    // Most of the way through the new window, the old count has decayed.
    clock.advance(55_000);
    expect(limiter.hit('u').allowed).toBe(true);
  });

  it('enforces an exact limit with the log variant', () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLog(3, 1000, clock.now);

    expect(limiter.hit('u').allowed).toBe(true);
    expect(limiter.hit('u').allowed).toBe(true);
    expect(limiter.hit('u').allowed).toBe(true);
    expect(limiter.hit('u').allowed).toBe(false);

    clock.advance(1001);
    expect(limiter.hit('u').allowed).toBe(true);
  });

  it('tracks a rolling failure rate', () => {
    const clock = fakeClock();
    const window = new RollingOutcomeWindow(10_000, 10, clock.now);

    for (let i = 0; i < 6; i += 1) window.record(false);
    for (let i = 0; i < 4; i += 1) window.record(true);

    const snapshot = window.snapshot();
    expect(snapshot.total).toBe(10);
    expect(snapshot.failureRate).toBeCloseTo(0.6);
  });

  it('forgets outcomes once the window rolls over', () => {
    const clock = fakeClock();
    const window = new RollingOutcomeWindow(10_000, 10, clock.now);
    window.record(false);
    clock.advance(11_000);
    expect(window.snapshot().total).toBe(0);
  });
});

describe('DirectedGraph', () => {
  function buildTravelGraph() {
    const graph = new DirectedGraph<string>();
    graph.addEdge({ from: 'travel-app', to: 'flights' });
    graph.addEdge({ from: 'travel-app', to: 'hotels' });
    graph.addEdge({ from: 'travel-app', to: 'currency' });
    graph.addEdge({ from: 'flights', to: 'amadeus' });
    graph.addEdge({ from: 'amadeus', to: 'oauth2' });
    return graph;
  }

  it('traverses breadth-first with depths', () => {
    const order = buildTravelGraph().bfs('travel-app');
    expect(order[0]).toEqual({ id: 'travel-app', depth: 0 });
    expect(order.find((n) => n.id === 'oauth2')?.depth).toBe(3);
  });

  it('respects a maximum depth', () => {
    const order = buildTravelGraph().bfs('travel-app', 1);
    expect(order.map((n) => n.id)).toEqual(['travel-app', 'flights', 'hotels', 'currency']);
  });

  it('finds the shortest path', () => {
    expect(buildTravelGraph().shortestPath('travel-app', 'oauth2')).toEqual([
      'travel-app',
      'flights',
      'amadeus',
      'oauth2',
    ]);
  });

  it('returns null for an unreachable target', () => {
    const graph = buildTravelGraph();
    graph.addNode('orphan');
    expect(graph.shortestPath('travel-app', 'orphan')).toBeNull();
  });

  it('produces a dependency-safe topological order', () => {
    const order = buildTravelGraph().topologicalSort();
    expect(order).not.toBeNull();
    expect(order!.indexOf('oauth2')).toBeGreaterThan(order!.indexOf('amadeus'));
    expect(order!.indexOf('amadeus')).toBeGreaterThan(order!.indexOf('flights'));
  });

  it('detects a cycle and reports it', () => {
    const graph = new DirectedGraph();
    graph.addEdge({ from: 'a', to: 'b' });
    graph.addEdge({ from: 'b', to: 'c' });
    graph.addEdge({ from: 'c', to: 'a' });

    expect(graph.hasCycle()).toBe(true);
    expect(graph.topologicalSort()).toBeNull();

    const cycle = graph.findCycle();
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it('splits into weakly connected components', () => {
    const graph = buildTravelGraph();
    graph.addEdge({ from: 'other-app', to: 'sms' });
    const components = graph.connectedComponents();
    expect(components).toHaveLength(2);
  });
});
