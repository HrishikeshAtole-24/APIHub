/**
 * Authentication and authorization plugin (report 19, 19.1).
 *
 *   Request
 *     -> resolve session (always, so `request.user` is populated)
 *     -> requireAuth   401 when anonymous
 *     -> requireRole   403 when the role is insufficient
 *     -> handler
 *
 * Authentication (who you are) and authorization (what you may do) are kept as
 * separate hooks, exactly as the report specifies.
 */
import { getConfig } from '@apihub/config';
import type { PublicUser, UserRole } from '@apihub/contracts';
import { verifyCsrfToken } from '@apihub/security';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ForbiddenError, UnauthorizedError } from '../../shared/errors.js';
import type { AuthService } from '../../modules/auth/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: PublicUser | null;
    sessionId: string | null;
  }
}

/** Role hierarchy: a higher rank satisfies any requirement at or below it. */
const ROLE_RANK: Record<UserRole, number> = {
  user: 1,
  moderator: 2,
  admin: 3,
};

export function hasRole(user: PublicUser | null, required: UserRole): boolean {
  if (!user) return false;
  return (ROLE_RANK[user.role] ?? 0) >= (ROLE_RANK[required] ?? Infinity);
}

export function registerAuth(app: FastifyInstance, authService: AuthService): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  const config = getConfig();

  // Populate the session on every request. Endpoints that do not require auth
  // still benefit: they can personalise (e.g. "is this favorited?").
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const cookie = request.cookies?.[config.COOKIE_NAME];
    const session = await authService.resolveSession(cookie);

    if (session) {
      request.user = session.user;
      request.sessionId = session.sessionId;
      request.log = request.log.child({ userId: session.user.id });
    }
  });
}

/** preHandler: reject anonymous requests. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!request.user) throw new UnauthorizedError();
}

/** preHandler factory: reject requests below a required role. */
export function requireRole(role: UserRole) {
  return async function roleHook(request: FastifyRequest): Promise<void> {
    if (!request.user) throw new UnauthorizedError();
    if (!hasRole(request.user, role)) {
      throw new ForbiddenError(`This action requires the "${role}" role.`);
    }
  };
}

/**
 * CSRF protection for cookie-authenticated state-changing requests
 * (report 19).
 *
 * SameSite=Lax on the session cookie already blocks cross-site POSTs in modern
 * browsers, but this is defence in depth for older clients and for the
 * cross-origin setup APIHub actually runs (web on :3000, API on :4000), where
 * the cookie must be SameSite=None in some deployments.
 *
 * Safe methods are exempt, and so are requests with no session (there is
 * nothing to forge without one).
 */
export async function requireCsrf(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (!request.sessionId) return;

  const config = getConfig();
  const token = request.headers['x-csrf-token'];

  if (typeof token !== 'string' || !verifyCsrfToken(token, request.sessionId, config.AUTH_SECRET)) {
    throw new ForbiddenError('Missing or invalid CSRF token.');
  }
}

/** Cookie attributes for the session cookie. */
export function sessionCookieOptions(expiresAt: Date): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none' | 'strict';
  expires: Date;
  domain?: string;
} {
  const config = getConfig();

  return {
    path: '/',
    // Not readable by JavaScript: an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    // Cross-origin dev (web :3000 -> api :4000) needs None, which browsers
    // only honour together with Secure. Lax is used when not on TLS.
    sameSite: config.COOKIE_SECURE ? 'none' : 'lax',
    expires: expiresAt,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  };
}

/** Attributes for clearing the session cookie on logout. */
export function clearCookieOptions(): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none' | 'strict';
  domain?: string;
} {
  const config = getConfig();
  return {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SECURE ? 'none' : 'lax',
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  };
}
