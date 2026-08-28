/**
 * Authentication routes (report 19, 32).
 */
import { getConfig } from '@apihub/config';
import { LoginRequestSchema, RegisterRequestSchema } from '@apihub/contracts';
import { generateCsrfToken } from '@apihub/security';
import type { FastifyInstance } from 'fastify';

import type { Container } from '../app/container.js';
import { ok } from '../app/envelope.js';
import { clearCookieOptions, requireAuth, sessionCookieOptions } from '../app/plugins/auth.js';
import { rateLimit } from '../app/plugins/rate-limit.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const config = getConfig();

  app.post('/auth/register', { preHandler: rateLimit('auth') }, async (request, reply) => {
    const input = RegisterRequestSchema.parse(request.body);

    const { user, cookie, expiresAt } = await container.auth.register({
      ...input,
      ipAddress: request.clientIp,
      userAgent: request.headers['user-agent'],
    });

    return reply
      .setCookie(config.COOKIE_NAME, cookie, sessionCookieOptions(expiresAt))
      .header('Cache-Control', 'no-store')
      .status(201)
      .send(ok(request, { user, expiresAt: expiresAt.toISOString() }));
  });

  app.post('/auth/login', { preHandler: rateLimit('auth') }, async (request, reply) => {
    const input = LoginRequestSchema.parse(request.body);

    const { user, cookie, expiresAt } = await container.auth.login({
      ...input,
      ipAddress: request.clientIp,
      userAgent: request.headers['user-agent'],
    });

    return reply
      .setCookie(config.COOKIE_NAME, cookie, sessionCookieOptions(expiresAt))
      .header('Cache-Control', 'no-store')
      .send(ok(request, { user, expiresAt: expiresAt.toISOString() }));
  });

  app.post('/auth/logout', async (request, reply) => {
    await container.auth.logout(request.cookies?.[config.COOKIE_NAME]);

    return reply
      .clearCookie(config.COOKIE_NAME, clearCookieOptions())
      .header('Cache-Control', 'no-store')
      .send(ok(request, { loggedOut: true }));
  });

  /**
   * Current session.
   *
   * Also mints the CSRF token, since a token is only meaningful once a session
   * exists. The frontend calls this on load and sends the token back in the
   * X-CSRF-Token header on state-changing requests.
   */
  app.get('/auth/session', async (request, reply) => {
    if (!request.user || !request.sessionId) {
      return reply
        .header('Cache-Control', 'no-store')
        .send(ok(request, { user: null, csrfToken: null }));
    }

    return reply.header('Cache-Control', 'no-store').send(
      ok(request, {
        user: request.user,
        csrfToken: generateCsrfToken(request.sessionId, config.AUTH_SECRET),
      }),
    );
  });

  /** Revoke every session for the current user. */
  app.post('/auth/logout-all', { preHandler: requireAuth }, async (request, reply) => {
    const revoked = await container.auth.logoutAll(request.user!.id);

    return reply
      .clearCookie(config.COOKIE_NAME, clearCookieOptions())
      .header('Cache-Control', 'no-store')
      .send(ok(request, { revoked }));
  });
}
