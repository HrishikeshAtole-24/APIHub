/**
 * Lightweight metrics (report 27.1).
 *
 * A full OpenTelemetry pipeline is the documented target (ADR-014), but it
 * needs a collector to be useful. These in-process counters, gauges and
 * histograms give the ops dashboard and `/healthz` real numbers with no
 * infrastructure, and they expose a Prometheus text endpoint so a scraper can
 * pick them up when one exists.
 *
 * Histograms use fixed buckets rather than storing samples, so memory is
 * constant regardless of traffic.
 */

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  buckets: { le: number; count: number }[];
}

/** Latency buckets in milliseconds, matching the report's SLO targets. */
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10_000];

export class Histogram {
  private readonly bounds: number[];
  private readonly counts: number[];
  private sum = 0;
  private total = 0;
  private minValue: number | null = null;
  private maxValue: number | null = null;

  constructor(buckets: number[] = DEFAULT_BUCKETS) {
    this.bounds = [...buckets].sort((a, b) => a - b);
    // One extra slot for the +Inf bucket.
    this.counts = new Array(this.bounds.length + 1).fill(0);
  }

  observe(value: number): void {
    this.sum += value;
    this.total += 1;
    this.minValue = this.minValue === null ? value : Math.min(this.minValue, value);
    this.maxValue = this.maxValue === null ? value : Math.max(this.maxValue, value);

    // Linear scan is fine: the bucket list is short and this is a hot path
    // where a binary search's branch overhead is not worth it.
    let index = this.bounds.length;
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= (this.bounds[i] as number)) {
        index = i;
        break;
      }
    }
    this.counts[index] = (this.counts[index] as number) + 1;
  }

  /**
   * Estimate a quantile from cumulative bucket counts.
   *
   * This is an approximation bounded by bucket width, which is the standard
   * trade-off Prometheus histograms make: exact quantiles would require
   * retaining every sample.
   */
  private quantile(q: number): number | null {
    if (this.total === 0) return null;

    const target = q * this.total;
    let cumulative = 0;

    for (let i = 0; i < this.counts.length; i += 1) {
      cumulative += this.counts[i] as number;
      if (cumulative >= target) {
        return i < this.bounds.length ? (this.bounds[i] as number) : (this.maxValue ?? 0);
      }
    }
    return this.maxValue;
  }

  snapshot(): HistogramSnapshot {
    let cumulative = 0;
    const buckets = this.bounds.map((le, i) => {
      cumulative += this.counts[i] as number;
      return { le, count: cumulative };
    });

    return {
      count: this.total,
      sum: this.sum,
      min: this.minValue,
      max: this.maxValue,
      mean: this.total === 0 ? null : this.sum / this.total,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      buckets,
    };
  }

  reset(): void {
    this.counts.fill(0);
    this.sum = 0;
    this.total = 0;
    this.minValue = null;
    this.maxValue = null;
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly startedAt = Date.now();

  increment(name: string, amount = 1, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = new Histogram();
      this.histograms.set(key, histogram);
    }
    histogram.observe(value);
  }

  /** Time an async operation and record its duration and outcome. */
  async time<T>(name: string, operation: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
    const started = performance.now();
    try {
      const result = await operation();
      this.observe(name, performance.now() - started, { ...labels, outcome: 'success' });
      return result;
    } catch (error) {
      this.observe(name, performance.now() - started, { ...labels, outcome: 'error' });
      throw error;
    }
  }

  getCounter(name: string, labels?: Record<string, string>): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  getHistogram(name: string, labels?: Record<string, string>): HistogramSnapshot | null {
    return this.histograms.get(this.key(name, labels))?.snapshot() ?? null;
  }

  get uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** Everything, as plain JSON, for the admin ops endpoint. */
  snapshot(): {
    uptimeSeconds: number;
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, HistogramSnapshot>;
  } {
    return {
      uptimeSeconds: this.uptimeSeconds,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].map(([key, histogram]) => [key, histogram.snapshot()]),
      ),
    };
  }

  /** Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];

    for (const [key, value] of this.counters) {
      lines.push(`# TYPE ${this.baseName(key)} counter`);
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      lines.push(`# TYPE ${this.baseName(key)} gauge`);
      lines.push(`${key} ${value}`);
    }
    for (const [key, histogram] of this.histograms) {
      const snapshot = histogram.snapshot();
      const base = this.baseName(key);
      const labelPart = key.slice(base.length);

      lines.push(`# TYPE ${base} histogram`);
      for (const bucket of snapshot.buckets) {
        const labels = labelPart
          ? `${labelPart.slice(0, -1)},le="${bucket.le}"}`
          : `{le="${bucket.le}"}`;
        lines.push(`${base}_bucket${labels} ${bucket.count}`);
      }
      lines.push(`${base}_sum${labelPart} ${snapshot.sum}`);
      lines.push(`${base}_count${labelPart} ${snapshot.count}`);
    }

    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private baseName(key: string): string {
    const brace = key.indexOf('{');
    return brace === -1 ? key : key.slice(0, brace);
  }

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    // Sort labels so the same set always produces the same series key.
    const rendered = Object.entries(labels)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, value]) => `${label}="${String(value).replace(/"/g, '')}"`)
      .join(',');
    return `${name}{${rendered}}`;
  }
}

export const metrics = new MetricsRegistry();

/**
 * Event-loop lag sampler (report 33.2: "measure event-loop lag").
 *
 * Sustained lag means CPU-bound work is blocking request handling, which is
 * the failure mode the report warns about for parsing and embeddings.
 */
export function startEventLoopMonitor(intervalMs = 5000): () => void {
  let last = performance.now();

  const timer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - last - intervalMs);
    metrics.gauge('event_loop_lag_ms', lag);
    last = now;
  }, intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
}

/** Current event-loop lag gauge. */
export function eventLoopLagMs(): number {
  return metrics.snapshot().gauges['event_loop_lag_ms'] ?? 0;
}
