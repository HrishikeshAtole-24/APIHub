/**
 * Retry with exponential backoff and jitter (report 22, 23, 25).
 *
 * Two rules from the report drive this implementation:
 *
 *  - "Only retry transient failures." Retrying a 400 or a 401 is pointless and
 *    turns one bad request into several. Classification is therefore explicit,
 *    and the default classifier is conservative.
 *
 *  - "Use exponential backoff + jitter." Without jitter, N clients that fail
 *    together retry together, reproducing the spike that caused the failure.
 *    Full jitter (random between 0 and the computed delay) gives the best
 *    spread and is what is used here.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Delay before the second attempt, in milliseconds. */
  baseDelayMs?: number;
  /** Upper bound on any single delay. */
  maxDelayMs?: number;
  /** Growth factor per attempt. */
  factor?: number;
  /** Decide whether an error is worth retrying. */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  /** Observability hook, called before each wait. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Abort signal; a cancelled operation stops retrying immediately. */
  signal?: AbortSignal;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Node/undici error codes that represent transient network conditions. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** HTTP statuses worth retrying. 429 and 5xx only; never a 4xx we caused. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isTransientError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;

  const candidate = error as { code?: string; status?: number; statusCode?: number; name?: string };

  if (candidate.code && TRANSIENT_CODES.has(candidate.code)) return true;
  if (candidate.name === 'AbortError') return false; // deliberate cancellation

  const status = candidate.status ?? candidate.statusCode;
  if (typeof status === 'number') return RETRYABLE_STATUSES.has(status);

  return false;
}

/** Full-jitter backoff: uniform random in [0, min(max, base * factor^attempt)]. */
export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  factor: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt - 1));
  return Math.round(random() * exponential);
}

export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Failed after ${attempts} attempt(s): ${reason}`);
    this.name = 'RetryExhaustedError';
    if (lastError instanceof Error) this.cause = lastError;
  }
}

/**
 * Execute `operation`, retrying transient failures.
 *
 * The operation receives the attempt number (1-based) so it can, for example,
 * shorten its own timeout on later attempts.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 10_000,
    factor = 2,
    isRetryable = isTransientError,
    onRetry,
    signal,
    sleep = defaultSleep,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('Operation aborted');

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !isRetryable(error, attempt)) throw error;

      const delayMs = computeBackoff(attempt, baseDelayMs, maxDelayMs, factor);
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}

/**
 * Run an async operation under a hard deadline.
 *
 * Report 23: "every external call must have bounded time". The AbortSignal is
 * passed to the operation so the underlying socket is actually torn down,
 * rather than merely abandoning the promise.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out',
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${message} after ${timeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      (timeoutError as { code?: string }).code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency map.
 *
 * Health probes run against many hosts at once, but unbounded parallelism
 * exhausts sockets and file descriptors. This keeps at most `concurrency`
 * operations in flight (report 23, backpressure).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
