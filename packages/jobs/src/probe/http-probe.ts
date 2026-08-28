/**
 * Health probe (Template Method, report 22: "Common probe lifecycle —
 * HttpProbe base workflow").
 *
 * The lifecycle is fixed:
 *   validate -> connect -> measure -> classify -> bound
 *
 * Subclasses/strategies vary only the request shape, never the safety steps.
 * Report 17.2 is explicit that probes must not leak response bodies, so only
 * bounded metadata is ever returned: status, latency, size, error class.
 */
import { getConfig } from '@apihub/config';
import { getLogger } from '@apihub/logger';
import { createPinnedLookup, SsrfError, validateTargetUrl } from '@apihub/security';
import { Agent, request as undiciRequest } from 'undici';

import type { ProbeResult } from '@apihub/domain';

const log = getLogger('worker.probe');

export interface ProbeTarget {
  apiId: string;
  slug: string;
  url: string;
}

/** Classified failure codes. Deliberately coarse; they are shown to users. */
export type ProbeErrorCode =
  | 'BLOCKED_ADDRESS'
  | 'DNS_FAILURE'
  | 'CONNECTION_REFUSED'
  | 'TLS_ERROR'
  | 'TIMEOUT'
  | 'RESET'
  | 'PROTOCOL_ERROR'
  | 'UNKNOWN';

/** Map a transport-level error onto a stable code. */
export function classifyError(error: unknown): ProbeErrorCode {
  if (error instanceof SsrfError) {
    return error.code === 'DNS_RESOLUTION_FAILED' ? 'DNS_FAILURE' : 'BLOCKED_ADDRESS';
  }

  const code = (error as { code?: string }).code ?? '';
  const name = (error as { name?: string }).name ?? '';
  const message = ((error as { message?: string }).message ?? '').toLowerCase();

  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return 'TIMEOUT';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_FAILURE';
  if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'RESET';
  if (code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || message.includes('certificate')) {
    return 'TLS_ERROR';
  }
  if (code.startsWith('UND_ERR')) return 'PROTOCOL_ERROR';
  return 'UNKNOWN';
}

/**
 * Execute one probe.
 *
 * Never throws: a probe failure is DATA (an observation that the API is down),
 * not an exception. A throwing probe would fail the worker job and trigger a
 * pointless retry.
 */
export async function probe(target: ProbeTarget): Promise<ProbeResult> {
  const config = getConfig();
  const timeoutMs = config.HEALTH_PROBE_TIMEOUT_MS;
  const startedAt = performance.now();

  let agent: Agent | null = null;

  try {
    // Same SSRF boundary as the playground: a catalogue entry could point
    // anywhere, including at our own internal network (report 20.2).
    const validated = await validateTargetUrl(target.url, {
      allowHttp: true, // many catalogue entries are http-only; we still record that
      hostAllowlist: [],
      maxRedirects: 2,
    });

    agent = new Agent({
      connect: {
        lookup: createPinnedLookup(validated.addresses) as never,
        timeout: Math.min(timeoutMs, 5000),
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const response = await undiciRequest(validated.url, {
      // HEAD is cheaper, but too many APIs answer it with 405. GET with an
      // immediately-discarded body is more accurate and still bounded.
      //
      // Redirects are NOT followed: a 3xx proves the host is reachable and
      // responding, which is all a health probe needs, and following one would
      // require re-validating the hop through the SSRF guard for no benefit.
      method: 'GET',
      headers: {
        'user-agent': config.INGESTION_USER_AGENT,
        accept: '*/*',
      },
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: agent,
    });

    const latencyMs = Math.round(performance.now() - startedAt);

    // Read a bounded prefix to confirm the body is actually served, then
    // discard. We never retain content (report 17.2).
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += (chunk as Buffer).length;
        if (bytes > 65_536) break;
      }
      await response.body.dump().catch(() => {});
    } catch {
      // A body read failure after headers arrived does not change the verdict.
    }

    return {
      httpStatus: response.statusCode,
      latencyMs,
      errorCode: null,
      responseBytes: bytes,
    };
  } catch (error) {
    const errorCode = classifyError(error);
    log.debug({ slug: target.slug, errorCode }, 'probe failed');

    return {
      httpStatus: null,
      latencyMs: Math.round(performance.now() - startedAt),
      errorCode,
      responseBytes: null,
    };
  } finally {
    await agent?.close().catch(() => {});
  }
}
