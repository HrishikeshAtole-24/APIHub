/**
 * Test environment setup.
 *
 * Runs BEFORE any module imports @apihub/config, which memoises configuration
 * on first access.
 *
 * Rate limits are raised because the integration suite issues hundreds of
 * requests from a single synthetic client and would otherwise throttle itself.
 * The limiter ALGORITHMS are covered by unit tests in @apihub/runtime, and the
 * middleware wiring is asserted here via the RateLimit-* response headers.
 */
process.env['NODE_ENV'] = 'test';
// The repo .env sets LOG_LEVEL=debug for development; override it so a passing
// suite is not buried in expected 4xx warnings.
process.env['LOG_LEVEL'] = 'silent';
process.env['AUTH_SECRET'] = 'test-only-secret-value-at-least-32-characters-long';
process.env['DATABASE_DRIVER'] = 'pglite';
process.env['DATABASE_URL'] = '';
process.env['REDIS_URL'] = '';
process.env['COOKIE_SECURE'] = 'false';

process.env['RATE_LIMIT_IP_PER_MIN'] = '100000';
process.env['RATE_LIMIT_USER_PER_MIN'] = '100000';
process.env['RATE_LIMIT_SEARCH_PER_MIN'] = '100000';
process.env['RATE_LIMIT_PLAYGROUND_PER_MIN'] = '100000';
process.env['RATE_LIMIT_AUTH_PER_MIN'] = '100000';
process.env['RATE_LIMIT_WRITE_PER_MIN'] = '100000';
process.env['RATE_LIMIT_ADMIN_PER_MIN'] = '100000';
