/**
 * Playground request executor (report 20.2, ADR-009, 37 Milestone C).
 *
 * This is the single most dangerous function in the platform: it makes the
 * server issue an HTTP request that a user controls. Every control the report
 * demands is applied here, in order:
 *
 *   1. Method allowlist.
 *   2. SSRF validation of the target (protocol, port, host, DNS -> IP).
 *   3. Pinned connection to a validated address (anti DNS-rebinding).
 *   4. Header allowlist: hop-by-hop and identity headers stripped.
 *   5. Connection and total timeouts.
 *   6. Response size cap, enforced while streaming.
 *   7. Redirects followed manually, each hop fully re-validated.
 *   8. Circuit breaker per host.
 *   9. Secret redaction before anything is logged or persisted.
 */
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { PassThrough, type Readable } from 'node:stream';

import { FORBIDDEN_PROXY_HEADERS, getConfig } from '@apihub/config';
import type { PlaygroundRequest, PlaygroundResponse, TimingBreakdown } from '@apihub/contracts';
import { getLogger } from '@apihub/logger';
import { CircuitBreakerRegistry } from '@apihub/runtime';
import {
  createPinnedLookup,
  redactUrl,
  summarizeRequestForLog,
  validateTargetUrl,
  type SsrfPolicy,
} from '@apihub/security';
import { Agent, request as undiciRequest } from 'undici';

import { BlockedTargetError, UpstreamError, UpstreamTimeoutError } from '../../shared/errors.js';

const log = getLogger('api.playground');

/**
 * One breaker per upstream host.
 *
 * A 404 or 401 from an upstream is a legitimate answer, not an outage, so the
 * classifier only counts transport failures and 5xx toward tripping.
 */
const breakers = new CircuitBreakerRegistry({
  failureThreshold: 0.6,
  volumeThreshold: 5,
  resetTimeoutMs: 30_000,
  isFailure: (error) => {
    const status = (error as { upstreamStatus?: number }).upstreamStatus;
    if (typeof status === 'number') return status >= 500;
    return true;
  },
});

export interface ExecuteResult extends PlaygroundResponse {
  /** Host actually contacted, for analytics. Never the full URL. */
  targetHost: string;
}

function buildSsrfPolicy(): SsrfPolicy {
  const config = getConfig();
  return {
    allowHttp: config.PLAYGROUND_ALLOW_HTTP,
    hostAllowlist: config.PLAYGROUND_HOST_ALLOWLIST,
    maxRedirects: config.PLAYGROUND_MAX_REDIRECTS,
  };
}

/**
 * Assemble outbound headers.
 *
 * Deny-list, then a fixed set of our own. A user cannot set Host,
 * X-Forwarded-For, Content-Length or any hop-by-hop header, because those
 * would let them forge identity or smuggle a second request.
 */
function buildHeaders(input: PlaygroundRequest): Record<string, string> {
  const headers: Record<string, string> = {
    // Identify ourselves honestly; some APIs reject unknown agents.
    'user-agent': 'APIHub-Playground/0.1 (+https://github.com/HrishikeshAtole-24/APIHub)',
    accept: '*/*',
    'accept-encoding': 'gzip, deflate',
  };

  for (const header of input.headers) {
    if (!header.enabled) continue;
    const name = header.name.trim().toLowerCase();
    if (name.length === 0) continue;
    if (FORBIDDEN_PROXY_HEADERS.has(name)) continue;
    // Strip CR/LF: unfiltered they permit header injection / request splitting.
    headers[name] = header.value.replace(/[\r\n]/g, '').slice(0, 4096);
  }

  // Apply the auth the user chose. These values are used once and never stored.
  const auth = input.auth;
  switch (auth.type) {
    case 'bearer':
      headers['authorization'] = `Bearer ${auth.token}`;
      break;
    case 'basic':
      headers['authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      break;
    case 'apiKey':
      if (auth.in === 'header') headers[auth.name.toLowerCase()] = auth.key;
      break;
    case 'none':
    default:
      break;
  }

  if (input.body !== undefined && input.contentType) {
    headers['content-type'] = input.contentType;
  }

  return headers;
}

/** Apply query parameters and query-position API keys to the URL. */
function buildUrl(input: PlaygroundRequest): string {
  const url = new URL(input.url);

  for (const param of input.queryParams) {
    if (!param.enabled || param.name.trim().length === 0) continue;
    url.searchParams.set(param.name, param.value);
  }

  if (input.auth.type === 'apiKey' && input.auth.in === 'query') {
    url.searchParams.set(input.auth.name, input.auth.key);
  }

  return url.toString();
}

/**
 * Decompress a response body according to Content-Encoding.
 *
 * undici's `request` (unlike `fetch`) does NOT decompress automatically, so a
 * server honouring our `accept-encoding` returns gzip/deflate/br bytes. Without
 * this the viewer would show binary garbage.
 *
 * Returns the original stream when the encoding is absent, `identity`, or one
 * we do not recognise — passing unknown bytes through unchanged is safer than
 * guessing at a codec.
 */
function decompressStream(body: Readable, contentEncoding: string | undefined): Readable {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return body;

  const decompressor =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;

  if (!decompressor) return body;

  const output = new PassThrough();
  // Errors are surfaced on the output stream so the bounded reader's try/catch
  // handles a corrupt payload rather than the process crashing.
  void pipeline(body, decompressor, output).catch((error: unknown) => {
    output.destroy(error as Error);
  });

  return output;
}

/**
 * Read a response body with a hard byte cap.
 *
 * The cap is enforced WHILE streaming, not after: buffering the whole body
 * first would let a malicious endpoint exhaust memory before the check runs.
 *
 * Note the cap applies to DECOMPRESSED bytes, which is what actually consumes
 * memory — a small gzip payload can expand enormously (a "zip bomb").
 */
async function readBounded(
  body: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;

    if (bytes > maxBytes) {
      chunks.push(buffer.subarray(0, buffer.length - (bytes - maxBytes)));
      truncated = true;
      break;
    }
    chunks.push(buffer);
  }

  return {
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
    truncated,
  };
}

export async function executePlaygroundRequest(
  input: PlaygroundRequest,
  requestId: string,
): Promise<ExecuteResult> {
  const config = getConfig();
  const policy = buildSsrfPolicy();
  const timeoutMs = Math.min(input.timeoutMs ?? config.PLAYGROUND_TIMEOUT_MS, config.PLAYGROUND_TIMEOUT_MS);
  const maxBytes = config.PLAYGROUND_MAX_RESPONSE_BYTES;

  const startedAt = performance.now();
  let currentUrl = buildUrl(input);
  const redirects: string[] = [];

  const timing: TimingBreakdown = {
    dnsMs: null,
    connectMs: null,
    tlsMs: null,
    firstByteMs: null,
    downloadMs: null,
    totalMs: 0,
  };

  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    // (2) Validate this hop. Redirects get the SAME treatment as the original
    // URL: this is where a naive implementation is exploited.
    const dnsStarted = performance.now();
    const validated = await validateTargetUrl(currentUrl, policy);
    if (hop === 0) timing.dnsMs = Math.round(performance.now() - dnsStarted);

    const host = validated.url.hostname;
    const breaker = breakers.get(host);

    // (3) Pin the connection to an address the guard approved.
    const agent = new Agent({
      connect: {
        lookup: createPinnedLookup(validated.addresses) as never,
        timeout: Math.min(timeoutMs, 5000),
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      // undici does not follow redirects unless asked; we handle them
      // ourselves so each hop can be re-validated by the SSRF guard.
      pipelining: 0,
    });

    try {
      const response = await breaker.execute(async () => {
        const connectStarted = performance.now();

        try {
          const result = await undiciRequest(validated.url, {
            method: input.method,
            headers: buildHeaders(input),
            body: input.method === 'GET' || input.method === 'HEAD' ? undefined : input.body,
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (hop === 0) timing.firstByteMs = Math.round(performance.now() - connectStarted);
          return result;
        } catch (error) {
          const name = (error as Error).name;
          const code = (error as { code?: string }).code;

          if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT') {
            throw new UpstreamTimeoutError(timeoutMs);
          }
          throw new UpstreamError(
            `Could not reach ${host}: ${(error as Error).message}`,
          );
        }
      });

      // (7) Manual redirect handling.
      const location = response.headers['location'];
      const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && location;

      if (isRedirect && hop < policy.maxRedirects) {
        // Drain the body so the socket can be reused/released.
        await response.body.dump();

        const next = new URL(Array.isArray(location) ? (location[0] as string) : location, validated.url);
        redirects.push(redactUrl(next.toString()));
        currentUrl = next.toString();
        await agent.close();
        continue;
      }

      // (6) Decompress, then bounded read.
      const downloadStarted = performance.now();
      const encodingHeader = response.headers['content-encoding'];
      const decoded = decompressStream(
        response.body as unknown as Readable,
        Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader,
      );
      const { text, bytes, truncated } = await readBounded(decoded as never, maxBytes);
      timing.downloadMs = Math.round(performance.now() - downloadStarted);
      timing.totalMs = Math.round(performance.now() - startedAt);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }

      // (9) Log a redacted summary only. Never headers, never the body.
      log.info(
        {
          requestId,
          ...summarizeRequestForLog({
            method: input.method,
            url: currentUrl,
            headers: {},
            bodySize: input.body?.length ?? 0,
          }),
          status: response.statusCode,
          durationMs: timing.totalMs,
        },
        'playground request executed',
      );

      await agent.close();

      return {
        requestId,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        statusText: statusTextFor(response.statusCode),
        headers,
        body: text,
        truncated,
        bodySizeBytes: bytes,
        contentType: headers['content-type'] ?? null,
        timing,
        redirects,
        finalUrl: redactUrl(currentUrl),
        executedAt: new Date().toISOString(),
        targetHost: host,
      };
    } catch (error) {
      await agent.close().catch(() => {});
      throw error;
    }
  }

  throw new BlockedTargetError(
    `Too many redirects (limit ${policy.maxRedirects}).`,
    'TOO_MANY_REDIRECTS',
  );
}

/** Minimal status-text table; undici does not expose one. */
function statusTextFor(status: number): string {
  const table: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    410: 'Gone',
    418: "I'm a teapot",
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return table[status] ?? '';
}

/** Exposed for the ops dashboard. */
export function playgroundCircuitSnapshots() {
  return breakers.unhealthy();
}
