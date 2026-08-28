/**
 * Rate limiting middleware (report 18).
 *
 * Layered policy, matching the report's table:
 *
 *   IP          100/min   anonymous abuse protection
 *   User        300/min   authenticated fairness
 *   Search       60/min   protects an expensive operation
 *   Playground   10/min   prevents the proxy being abused
 *   Admin        strict   protects privileged operations
 *
 * The subject is the authenticated user when there is one, otherwise the IP.
 * That way a shared corporate NAT does not throttle signed-in users, while
 * anonymous traffic from one address is still bounded.
 */
import { getConfig } from '@apihub/config';
import {
  LayeredRateLimiter,
  MemoryRateLimiter,
  RedisRateLimiter,
  getRedis,
  rateLimitHeaders,
  type RateLimiter,
  type RateLimitPolicy,
} from '@apihub/runtime';
import { getLogger } from '@apihub/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { RateLimitError } from '../../shared/errors.js';

const log = getLogger('api.rate-limit');

let limiter: RateLimiter | null = null;

export async function initRateLimiter(): Promise<RateLimiter> {
  if (limiter) return limiter;

  const redis = await getRedis();
  if (redis) {
    limiter = new LayeredRateLimiter(new RedisRateLimiter(redis));
    log.info('rate limiting: local + Redis (distributed)');
  } else {
    limiter = new MemoryRateLimiter();
    log.info('rate limiting: in-process only (single instance)');
  }
  return limiter;
}

export function getRateLimiter(): RateLimiter {
  if (!limiter) throw new Error('Rate limiter not initialised');
  return limiter;
}

/** Named policies, resolved from configuration at startup. */
export function buildPolicies(): Record<string, RateLimitPolicy> {
  const config = getConfig();
  return {
    global: { name: 'global', limit: config.RATE_LIMIT_IP_PER_MIN, windowSeconds: 60 },
    user: { name: 'user', limit: config.RATE_LIMIT_USER_PER_MIN, windowSeconds: 60 },
    search: { name: 'search', limit: config.RATE_LIMIT_SEARCH_PER_MIN, windowSeconds: 60 },
    playground: {
      name: 'playground',
      limit: config.RATE_LIMIT_PLAYGROUND_PER_MIN,
      windowSeconds: 60,
      // No burst allowance: the playground makes the server issue an outbound
      // request, so smoothing matters more than responsiveness here.
      burst: config.RATE_LIMIT_PLAYGROUND_PER_MIN,
    },
    auth: { name: 'auth', limit: config.RATE_LIMIT_AUTH_PER_MIN, windowSeconds: 60 },
    write: { name: 'write', limit: config.RATE_LIMIT_WRITE_PER_MIN, windowSeconds: 60 },
    admin: { name: 'admin', limit: config.RATE_LIMIT_ADMIN_PER_MIN, windowSeconds: 60 },
  };
}

let policies: Record<string, RateLimitPolicy> | null = null;

function policy(name: string): RateLimitPolicy {
  policies ??= buildPolicies();
  const found = policies[name];
  if (!found) throw new Error(`Unknown rate limit policy: ${name}`);
  return found;
}

/** Identify the subject a limit applies to. */
function subjectFor(request: FastifyRequest): string {
  return request.user ? `user:${request.user.id}` : `ip:${request.clientIp}`;
}

/**
 * Build a preHandler hook enforcing a named policy.
 *
 * Usage:
 *   app.get('/v1/search', { preHandler: rateLimit('search') }, handler)
 */
export function rateLimit(policyName: string, cost = 1) {
  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const selected = policy(policyName);
    const decision = await getRateLimiter().check(subjectFor(request), selected, cost);

    for (const [header, value] of Object.entries(rateLimitHeaders(selected, decision))) {
      void reply.header(header, value);
    }

    if (!decision.allowed) {
      request.log.warn(
        { policy: policyName, subject: subjectFor(request) },
        'rate limit exceeded',
      );
      throw new RateLimitError(Math.ceil(decision.retryAfterMs / 1000));
    }
  };
}

/**
 * Global limit applied to every request before routing.
 *
 * Skips liveness endpoints so an orchestrator's probes cannot be throttled
 * into reporting the service as unhealthy.
 */
export async function globalRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = request.url.split('?')[0] ?? '';
  if (url === '/healthz' || url === '/readyz' || url === '/metrics') return;

  const selected = request.user ? policy('user') : policy('global');
  const decision = await getRateLimiter().check(subjectFor(request), selected);

  for (const [header, value] of Object.entries(rateLimitHeaders(selected, decision))) {
    void reply.header(header, value);
  }

  if (!decision.allowed) {
    throw new RateLimitError(Math.ceil(decision.retryAfterMs / 1000));
  }
}

/** Test seam. */
export function resetRateLimiter(): void {
  limiter = null;
  policies = null;
}
