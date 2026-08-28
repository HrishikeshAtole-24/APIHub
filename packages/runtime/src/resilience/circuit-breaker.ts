/**
 * Circuit breaker (report 22, 23, 35).
 *
 * APIHub talks to thousands of third-party APIs it does not control. When one
 * of them goes down, continuing to call it wastes worker capacity, ties up
 * sockets and slows every other probe. The breaker stops calling a failing
 * upstream and periodically checks whether it has recovered.
 *
 * State machine
 * -------------
 *            failures exceed threshold
 *   CLOSED ────────────────────────────► OPEN
 *      ▲                                   │
 *      │                                   │ resetTimeout elapses
 *      │ probe succeeds                    ▼
 *      └────────────── HALF_OPEN ◄─────────┘
 *                          │
 *                          │ probe fails
 *                          └──────────► OPEN
 *
 *   CLOSED     calls pass through; outcomes are recorded.
 *   OPEN       calls are rejected immediately with CircuitOpenError.
 *   HALF_OPEN  a limited number of trial calls are allowed through to test
 *              recovery. Success closes the circuit; one failure reopens it.
 *
 * The failure signal is a RATE over a rolling window, not a raw count: three
 * failures out of three matters, three out of three hundred does not.
 */
import { RollingOutcomeWindow } from '@apihub/algorithms';
import { getLogger } from '@apihub/logger';

const log = getLogger('circuit-breaker');

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';

  constructor(
    readonly circuitName: string,
    readonly retryAfterMs: number,
  ) {
    super(`Circuit "${circuitName}" is open; upstream is failing.`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Failure rate (0..1) at which the circuit trips. */
  failureThreshold?: number;
  /** Minimum calls in the window before the rate is trusted. */
  volumeThreshold?: number;
  /** Rolling window length in milliseconds. */
  windowMs?: number;
  /** How long to stay OPEN before allowing a trial call. */
  resetTimeoutMs?: number;
  /** Consecutive successes in HALF_OPEN required to close. */
  successesToClose?: number;
  /** Trial calls permitted concurrently while HALF_OPEN. */
  halfOpenMaxCalls?: number;
  /** Classify an error as a real failure. Return false to ignore it. */
  isFailure?: (error: unknown) => boolean;
  now?: () => number;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failureRate: number;
  total: number;
  failures: number;
  openedAt: number | null;
  retryAfterMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private openedAt: number | null = null;
  private halfOpenSuccesses = 0;
  private halfOpenInFlight = 0;

  private readonly window: RollingOutcomeWindow;
  private readonly now: () => number;

  private readonly failureThreshold: number;
  private readonly volumeThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successesToClose: number;
  private readonly halfOpenMaxCalls: number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? 0.5;
    this.volumeThreshold = options.volumeThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.successesToClose = options.successesToClose ?? 2;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
    this.isFailure = options.isFailure ?? (() => true);
    this.now = options.now ?? Date.now;
    this.window = new RollingOutcomeWindow(options.windowMs ?? 60_000, 10, this.now);
  }

  get name(): string {
    return this.options.name;
  }

  /** Current state, after applying any pending OPEN -> HALF_OPEN transition. */
  getState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  /**
   * Run `operation` under the breaker.
   *
   * @throws CircuitOpenError when the circuit is open.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();

    if (this.state === 'open') {
      throw new CircuitOpenError(this.name, this.retryAfterMs());
    }

    if (this.state === 'half_open') {
      // Admit only a small number of trial calls; the rest fail fast so a
      // recovering upstream is not immediately flooded.
      if (this.halfOpenInFlight >= this.halfOpenMaxCalls) {
        throw new CircuitOpenError(this.name, this.retryAfterMs());
      }
      this.halfOpenInFlight += 1;
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (this.isFailure(error)) this.recordFailure();
      else this.recordSuccess();
      throw error;
    } finally {
      if (this.state === 'half_open' && this.halfOpenInFlight > 0) {
        this.halfOpenInFlight -= 1;
      }
    }
  }

  /**
   * Run `operation`, falling back instead of throwing when the circuit is open.
   * Used where a degraded answer beats an error (report 35).
   */
  async executeWithFallback<T>(operation: () => Promise<T>, fallback: () => Promise<T> | T): Promise<T> {
    try {
      return await this.execute(operation);
    } catch (error) {
      if (error instanceof CircuitOpenError) return fallback();
      throw error;
    }
  }

  recordSuccess(): void {
    this.window.record(true);

    if (this.state === 'half_open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.successesToClose) this.close();
    }
  }

  recordFailure(): void {
    this.window.record(false);

    // A single failure during a trial immediately reopens the circuit.
    if (this.state === 'half_open') {
      this.open();
      return;
    }

    if (this.state === 'closed') {
      const { total, failureRate } = this.window.snapshot();
      if (total >= this.volumeThreshold && failureRate >= this.failureThreshold) {
        this.open();
      }
    }
  }

  snapshot(): CircuitSnapshot {
    const { total, failures, failureRate } = this.window.snapshot();
    return {
      name: this.name,
      state: this.getState(),
      failureRate,
      total,
      failures,
      openedAt: this.openedAt,
      retryAfterMs: this.retryAfterMs(),
    };
  }

  reset(): void {
    this.state = 'closed';
    this.openedAt = null;
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
    this.window.reset();
  }

  // ── internals ───────────────────────────────────────────────

  private open(): void {
    if (this.state === 'open') return;
    this.state = 'open';
    this.openedAt = this.now();
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
    log.warn({ circuit: this.name, ...this.window.snapshot() }, 'circuit opened');
  }

  private close(): void {
    this.state = 'closed';
    this.openedAt = null;
    this.halfOpenSuccesses = 0;
    this.window.reset();
    log.info({ circuit: this.name }, 'circuit closed');
  }

  private maybeHalfOpen(): void {
    if (this.state !== 'open' || this.openedAt === null) return;
    if (this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.halfOpenSuccesses = 0;
      this.halfOpenInFlight = 0;
      log.info({ circuit: this.name }, 'circuit half-open; probing upstream');
    }
  }

  private retryAfterMs(): number {
    if (this.state !== 'open' || this.openedAt === null) return 0;
    return Math.max(0, this.resetTimeoutMs - (this.now() - this.openedAt));
  }
}

/**
 * Registry of per-host circuit breakers.
 *
 * One breaker per upstream host: a broken weather API must not stop us calling
 * a healthy payments API. Idle breakers are evicted so the registry does not
 * grow without bound across thousands of catalogue hosts.
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly lastUsed = new Map<string, number>();

  constructor(private readonly defaults: Omit<CircuitBreakerOptions, 'name'> = {}) {}

  get(name: string): CircuitBreaker {
    this.lastUsed.set(name, Date.now());

    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...this.defaults, name });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /** Drop breakers unused for `maxIdleMs` and currently closed. */
  prune(maxIdleMs = 3_600_000): number {
    const cutoff = Date.now() - maxIdleMs;
    let removed = 0;

    for (const [name, used] of this.lastUsed) {
      if (used >= cutoff) continue;
      // Never forget an open circuit; that would silently retry a dead host.
      if (this.breakers.get(name)?.getState() !== 'closed') continue;
      this.breakers.delete(name);
      this.lastUsed.delete(name);
      removed += 1;
    }
    return removed;
  }

  /** Every non-closed circuit, for the ops dashboard. */
  unhealthy(): CircuitSnapshot[] {
    return [...this.breakers.values()]
      .map((breaker) => breaker.snapshot())
      .filter((snapshot) => snapshot.state !== 'closed');
  }

  get size(): number {
    return this.breakers.size;
  }

  clear(): void {
    this.breakers.clear();
    this.lastUsed.clear();
  }
}
