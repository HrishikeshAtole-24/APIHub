/**
 * Counting-free Bloom filter (report 21, "optional fast existence check for
 * ingestion").
 *
 * Ingestion pulls thousands of upstream records and must answer "have I already
 * seen this fingerprint?" before doing expensive normalisation and a database
 * round-trip. A Bloom filter answers that in constant time and a few hundred KB.
 *
 * Guarantees:
 *   - `has(x) === false`  -> x is DEFINITELY absent (no false negatives).
 *   - `has(x) === true`   -> x is PROBABLY present (false positives possible).
 *
 * Because false positives exist, a positive result must be confirmed against
 * PostgreSQL. The filter is an optimisation that removes the vast majority of
 * lookups, never an authority.
 *
 * Sizing (standard formulas):
 *   m = ceil(-n * ln(p) / (ln 2)^2)     bits
 *   k = round((m / n) * ln 2)           hash functions
 */

const LN2 = Math.LN2;
const LN2_SQUARED = LN2 * LN2;

export interface BloomFilterOptions {
  /** Expected number of distinct items. */
  expectedItems: number;
  /** Target false-positive rate, e.g. 0.01 for 1%. */
  falsePositiveRate?: number;
}

export class BloomFilter {
  private readonly bits: Uint32Array;
  private readonly bitCount: number;
  private readonly hashCount: number;
  private itemCount = 0;

  constructor(options: BloomFilterOptions) {
    const n = Math.max(1, options.expectedItems);
    const p = options.falsePositiveRate ?? 0.01;

    if (p <= 0 || p >= 1) throw new RangeError('falsePositiveRate must be between 0 and 1');

    this.bitCount = Math.ceil((-n * Math.log(p)) / LN2_SQUARED);
    this.hashCount = Math.max(1, Math.round((this.bitCount / n) * LN2));
    this.bits = new Uint32Array(Math.ceil(this.bitCount / 32));
  }

  get size(): number {
    return this.itemCount;
  }

  get bitSize(): number {
    return this.bitCount;
  }

  get hashFunctions(): number {
    return this.hashCount;
  }

  add(value: string): void {
    const [h1, h2] = this.baseHashes(value);
    for (let i = 0; i < this.hashCount; i += 1) {
      const bit = this.combinedHash(h1, h2, i);
      this.bits[bit >>> 5] = (this.bits[bit >>> 5] as number) | (1 << (bit & 31));
    }
    this.itemCount += 1;
  }

  /** False when definitely absent; true when probably present. */
  has(value: string): boolean {
    const [h1, h2] = this.baseHashes(value);
    for (let i = 0; i < this.hashCount; i += 1) {
      const bit = this.combinedHash(h1, h2, i);
      if (((this.bits[bit >>> 5] as number) & (1 << (bit & 31))) === 0) return false;
    }
    return true;
  }

  /** Add and report whether the value was probably already present. */
  addAndCheck(value: string): boolean {
    const existed = this.has(value);
    if (!existed) this.add(value);
    return existed;
  }

  clear(): void {
    this.bits.fill(0);
    this.itemCount = 0;
  }

  /** Current estimated false-positive probability given how full the filter is. */
  estimatedFalsePositiveRate(): number {
    return Math.pow(1 - Math.exp((-this.hashCount * this.itemCount) / this.bitCount), this.hashCount);
  }

  // ── hashing ─────────────────────────────────────────────────

  /**
   * Kirsch-Mitzenmacher optimisation: k independent hashes are simulated from
   * two, with no measurable increase in false positives.
   *   g_i(x) = h1(x) + i * h2(x)
   */
  private combinedHash(h1: number, h2: number, i: number): number {
    const combined = (h1 + Math.imul(i, h2) + Math.imul(i, i)) >>> 0;
    return combined % this.bitCount;
  }

  /** Two independent 32-bit hashes: FNV-1a and a djb2 variant. */
  private baseHashes(value: string): [number, number] {
    let fnv = 0x811c9dc5;
    let djb = 5381;

    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
      djb = (Math.imul(djb, 33) ^ code) >>> 0;
    }

    // Ensure h2 is odd and non-zero so the arithmetic progression covers the space.
    return [fnv >>> 0, (djb | 1) >>> 0];
  }
}
