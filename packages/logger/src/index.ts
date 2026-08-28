/**
 * Structured logging (report 27.1).
 *
 * Rules enforced here:
 *  - JSON in production, human-readable in development.
 *  - Secrets are redacted at the serialiser level, so a careless
 *    `log.info({ headers })` can never leak an Authorization header.
 *  - Every log line carries a requestId when one is in scope.
 */
import { getConfig } from '@apihub/config';
import { SENSITIVE_HEADERS, REDACTED } from '@apihub/config';
import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * Recursively redact sensitive keys from an arbitrary object.
 * Used for header/query bags whose shape we do not control.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? REDACTED
      : redact(val, depth + 1);
  }
  return out as unknown as T;
}

/** Pino redaction paths for the well-known request/response shapes we log. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  'passwordHash',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  '*.password',
  '*.token',
  '*.apiKey',
];

function buildOptions(name: string): LoggerOptions {
  const config = getConfig();

  // Tests are silent unless LOG_LEVEL is set explicitly, so a passing suite
  // does not bury its own output in application logs.
  const level =
    config.isTest && process.env['LOG_LEVEL'] === undefined ? 'silent' : config.LOG_LEVEL;

  const base: LoggerOptions = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    base: { service: name, env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  // Pretty output locally; raw JSON everywhere else so log shippers can parse it.
  if (config.isDevelopment && !config.isTest) {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
          messageFormat: '{msg}',
          singleLine: false,
        },
      },
    };
  }

  return base;
}

const registry = new Map<string, Logger>();

/**
 * Get (or create) a named logger. Named loggers let us filter by subsystem:
 *   `service=api`, `service=worker.health`, `service=ingestion`.
 */
export function getLogger(name = 'apihub'): Logger {
  const existing = registry.get(name);
  if (existing) return existing;
  const logger = pino(buildOptions(name));
  registry.set(name, logger);
  return logger;
}

/** Child logger bound to a correlation id (report 27.3). */
export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}

export const logger = getLogger('apihub');
