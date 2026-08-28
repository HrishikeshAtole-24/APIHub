/**
 * Fastify server assembly (report 11).
 *
 * Plugin order matters and is deliberate:
 *
 *   1. request context   every later hook and log line needs the requestId
 *   2. security headers  applied even to error responses
 *   3. cors              must run before routing to answer preflights
 *   4. cookies           auth depends on parsed cookies
 *   5. auth              populates request.user for rate limiting to key on
 *   6. rate limit        after auth, so signed-in users get the user policy
  *   7. error handler     BEFORE routes; see the note at the call site
 *   8. routes
 */
import { getConfig } from '@apihub/config';
import { getLogger } from '@apihub/logger';
import { buildSecurityHeaders } from '@apihub/security';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import { registerRoutes } from '../routes/index.js';
import { buildContainer, type Container } from './container.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { globalRateLimit, initRateLimiter } from './plugins/rate-limit.js';
import { registerRequestContext } from './plugins/request-context.js';

const log = getLogger('api');

/**
 * Suppresses Fastify's built-in per-request logging.
 *
 * We emit our own access log in the request-context plugin, with the
 * correlation id, route pattern and duration attached; Fastify's default would
 * be a second, less useful line for every request.
 *
 * This replaces the top-level `disableRequestLogging` option, which Fastify
 * deprecated in v5 and removes in v6.
 *
 * Fastify wants an INSTANCE here despite the option's type being named
 * `LogControllerClass`; internally it checks `instanceof LogController`.
 */
class QuietLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}

export interface BuiltServer {
  app: FastifyInstance;
  container: Container;
}

export async function buildServer(overrides?: Parameters<typeof buildContainer>[0]): Promise<BuiltServer> {
  const config = getConfig();

  // Fastify infers its logger generic from `loggerInstance`, which would make
  // every plugin signature depend on the concrete pino type. Pinning the
  // instance to the default FastifyInstance keeps plugin functions portable.
  const app: FastifyInstance = Fastify({
    // Pino is configured in @apihub/logger; reuse that instance so the API and
    // the worker produce identically-shaped logs.
    loggerInstance: log,
    // We generate our own correlation ids in the request-context plugin.
    genReqId: () => '',
    logController: new QuietLogController(),
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Trust the proxy only in production, where one actually sits in front.
    // Trusting it in development would let any client spoof X-Forwarded-For
    // and bypass IP rate limiting.
    trustProxy: config.isProduction,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }) as unknown as FastifyInstance;

  // 1. Correlation + access logging.
  registerRequestContext(app);

  // 2. Security headers on every response, including errors.
  const securityHeaders = buildSecurityHeaders({ enableHsts: config.COOKIE_SECURE });
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [header, value] of Object.entries(securityHeaders)) {
      if (value) void reply.header(header, value);
      else void reply.removeHeader(header);
    }
    return payload;
  });

  // 3. CORS. Credentials are allowed, so the origin list must be explicit —
  // a wildcard origin with credentials is rejected by browsers and would be
  // unsafe regardless.
  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and non-browser clients send no Origin header.
      if (!origin) return callback(null, true);
      if (config.CORS_ORIGINS.length === 0) return callback(null, config.isDevelopment);
      callback(null, config.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-ID', 'X-CSRF-Token'],
    exposedHeaders: [
      'X-Request-ID',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 86_400,
  });

  // 4. Cookies (signed at the application layer, not by this plugin).
  await app.register(cookie, {});

  const container = await buildContainer(overrides);

  // 5. Session resolution.
  registerAuth(app, container.auth);

  // 6. Global rate limiting, after auth so the subject is known.
  await initRateLimiter();
  app.addHook('preHandler', globalRateLimit);

  // 7. Error handling.
  //
  // MUST be registered BEFORE the routes. Routes are registered inside an
  // encapsulated `/v1` plugin context, and Fastify does not propagate an error
  // handler into child contexts that already exist. Registering it afterwards
  // silently leaves those routes on the default handler, which serialises
  // errors in Fastify's own shape and reports every one as a 500.
  registerErrorHandler(app);

  // 8. Routes.
  await registerRoutes(app, container);

  return { app, container };
}
