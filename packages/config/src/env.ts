/**
 * Typed, validated, fail-fast configuration.
 *
 * Design notes
 * ------------
 * - Configuration is parsed ONCE at process start and frozen. A misconfigured
 *   process should crash immediately and loudly rather than fail at 3am inside
 *   a request handler (report 4.3 "secure by default", 37 "secrets are
 *   environment-driven").
 * - Every value is validated with Zod so the rest of the codebase consumes a
 *   fully-typed object with no `process.env` access and no non-null assertions.
 * - Driver selection (pglite | neon | postgres) is inferred when not set, which
 *   is what makes zero-setup local development possible.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Walk upwards from a directory to find the monorepo root (holds pnpm-workspace.yaml). */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

let loaded = false;

/** Load .env from the repo root exactly once. Real environment variables always win. */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(here);
  for (const file of ['.env.local', '.env']) {
    const full = path.join(root, file);
    if (existsSync(full)) {
      dotenv.config({ path: full, override: false, quiet: true });
    }
  }
}

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) =>
      typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** Comma-separated string into a trimmed, non-empty string array. */
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const DatabaseDriverSchema = z.enum(['pglite', 'neon', 'postgres']);
export type DatabaseDriver = z.infer<typeof DatabaseDriverSchema>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // database
  DATABASE_DRIVER: DatabaseDriverSchema.optional(),
  DATABASE_URL: z.string().default(''),
  DATABASE_URL_UNPOOLED: z.string().default(''),
  PGLITE_DATA_DIR: z.string().default('.data/pglite'),
  DATABASE_POOL_MAX: int(10, 1, 100),

  // cache / queue
  REDIS_URL: z.string().default(''),
  REDIS_KEY_PREFIX: z.string().default('apihub'),

  // http server
  PORT: int(4000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: csv,
  BODY_LIMIT_BYTES: int(1_048_576, 1024),

  // auth
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_TTL_SECONDS: int(604_800, 60),
  COOKIE_NAME: z.string().default('apihub_session'),
  COOKIE_DOMAIN: z.string().default(''),
  COOKIE_SECURE: bool(false),

  // playground / SSRF boundary
  PLAYGROUND_TIMEOUT_MS: int(10_000, 100, 60_000),
  PLAYGROUND_MAX_RESPONSE_BYTES: int(2_097_152, 1024),
  PLAYGROUND_MAX_REDIRECTS: int(3, 0, 10),
  PLAYGROUND_ALLOW_HTTP: bool(false),
  PLAYGROUND_HOST_ALLOWLIST: csv,

  // health monitoring
  HEALTH_PROBE_TIMEOUT_MS: int(8000, 100, 60_000),
  HEALTH_PROBE_CONCURRENCY: int(8, 1, 128),
  HEALTH_SCHEDULE_INTERVAL_MS: int(300_000, 10_000),
  HEALTH_DEGRADED_LATENCY_MS: int(1500, 1),
  HEALTH_RETENTION_DAYS: int(90, 1),

  // ingestion
  INGESTION_SOURCE_URL: z
    .string()
    .default('https://raw.githubusercontent.com/public-apis/public-apis/master/README.md'),
  INGESTION_USER_AGENT: z.string().default('APIHub-Ingestion/0.1'),

  // rate limits
  RATE_LIMIT_IP_PER_MIN: int(100, 1),
  RATE_LIMIT_USER_PER_MIN: int(300, 1),
  RATE_LIMIT_SEARCH_PER_MIN: int(60, 1),
  RATE_LIMIT_PLAYGROUND_PER_MIN: int(10, 1),
  // Deliberately low: these protect credential-guessing and privileged actions.
  RATE_LIMIT_AUTH_PER_MIN: int(10, 1),
  RATE_LIMIT_WRITE_PER_MIN: int(60, 1),
  RATE_LIMIT_ADMIN_PER_MIN: int(30, 1),

  /**
   * Run background jobs inside the API process.
   *
   * Defaults on for embedded PGlite, which is single-writer and therefore
   * cannot be opened by a separate worker process at the same time.
   */
  WORKER_EMBEDDED: bool(false),

  // ai
  ANTHROPIC_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('claude-sonnet-5'),
  AI_ENABLED: bool(false),
});

export type RawEnv = z.infer<typeof EnvSchema>;

/**
 * Infer the database driver when it is not explicitly configured.
 *   no URL at all  -> pglite (zero-setup local development)
 *   neon.tech host -> neon serverless driver
 *   anything else  -> standard node-postgres
 */
function inferDriver(raw: RawEnv): DatabaseDriver {
  if (raw.DATABASE_DRIVER) return raw.DATABASE_DRIVER;
  if (!raw.DATABASE_URL) return 'pglite';
  return /neon\.tech|neon\.build/i.test(raw.DATABASE_URL) ? 'neon' : 'postgres';
}

export interface AppConfig extends RawEnv {
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly databaseDriver: DatabaseDriver;
  /** True when a real Redis is configured; otherwise in-memory fallbacks are used. */
  readonly redisEnabled: boolean;
  /** True only when AI is switched on AND a key is present. */
  readonly aiEnabled: boolean;
  /** Connection string for migrations. Neon requires a direct, non-pooled URL. */
  readonly migrationUrl: string;
}

function build(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Hint: copy .env.example to .env at the repository root.',
    );
  }

  const raw = parsed.data;
  const driver = inferDriver(raw);

  // Production guardrails. These exist so an insecure default can never ship.
  if (raw.NODE_ENV === 'production') {
    if (driver === 'pglite') {
      throw new Error(
        'DATABASE_DRIVER=pglite is not permitted in production. Configure Neon or PostgreSQL.',
      );
    }
    if (raw.AUTH_SECRET.includes('dev-only')) {
      throw new Error('AUTH_SECRET still holds the development placeholder. Generate a real secret.');
    }
    if (!raw.COOKIE_SECURE) {
      throw new Error('COOKIE_SECURE must be true in production.');
    }
  }

  return Object.freeze({
    ...raw,
    isProduction: raw.NODE_ENV === 'production',
    isDevelopment: raw.NODE_ENV === 'development',
    isTest: raw.NODE_ENV === 'test',
    databaseDriver: driver,
    redisEnabled: raw.REDIS_URL.length > 0,
    aiEnabled: raw.AI_ENABLED && raw.ANTHROPIC_API_KEY.length > 0,
    migrationUrl: raw.DATABASE_URL_UNPOOLED || raw.DATABASE_URL,
  });
}

let cached: AppConfig | null = null;

/** Lazily parse and memoise configuration. Throws on first access if invalid. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  loadEnvFiles();
  cached = build(process.env);
  return cached;
}

/** Test seam: build a config from an explicit object without touching the cache. */
export function buildConfigFrom(source: NodeJS.ProcessEnv): AppConfig {
  return build(source);
}

/** Test seam: drop the memoised config so the next getConfig() re-parses. */
export function resetConfigCache(): void {
  cached = null;
  loaded = false;
}
