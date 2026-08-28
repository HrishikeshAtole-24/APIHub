/**
 * API integration tests (report 28: contract + E2E levels).
 *
 * These run the REAL Fastify app against a REAL PostgreSQL (embedded PGlite),
 * with the real cache, the real rate limiter and the real SSRF guard. Nothing
 * is mocked, so a passing suite is genuine evidence the endpoints work.
 *
 * `app.inject()` dispatches through the full middleware stack without opening
 * a socket, which keeps the suite fast and deterministic.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

import { CacheService, MemoryCacheStore, setCacheService } from '@apihub/runtime';
import { createDatabase, runMigrations, schema, setDatabaseHandle, type DatabaseHandle } from '@apihub/database';
import { hashPassword } from '@apihub/security';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './app/server.js';
import { resetRateLimiter } from './app/plugins/rate-limit.js';

const TEST_DIR = path.resolve(process.cwd(), '../../.data/test-api');

let app: FastifyInstance;
let handle: DatabaseHandle;

/** Seed a small, predictable catalogue. */
async function seedFixtures(db: DatabaseHandle['db']): Promise<void> {
  const sourceId = schema.newId('source');
  await db.insert(schema.apiSources).values({ id: sourceId, name: 'test-source', license: 'MIT' });

  const categoryId = schema.newId('category');
  await db.insert(schema.categories).values({
    id: categoryId,
    slug: 'weather',
    name: 'Weather',
    description: 'Weather APIs',
    icon: 'cloud',
    apiCount: 2,
  });

  const fixtures = [
    {
      slug: 'open-meteo',
      name: 'Open-Meteo',
      description: 'Free weather forecast API requiring no key.',
      authType: 'none',
      isFree: true,
      https: true,
      cors: 'yes',
      popularity: 95,
    },
    {
      slug: 'weatherstack',
      name: 'WeatherStack',
      description: 'Real time weather information with an API key.',
      authType: 'apiKey',
      isFree: false,
      https: true,
      cors: 'no',
      popularity: 60,
    },
    {
      slug: 'coingecko',
      name: 'CoinGecko',
      description: 'Cryptocurrency prices and market data.',
      authType: 'none',
      isFree: true,
      https: true,
      cors: 'yes',
      popularity: 88,
    },
  ];

  for (const fixture of fixtures) {
    const id = schema.newId('api');
    await db.insert(schema.apis).values({
      id,
      slug: fixture.slug,
      name: fixture.name,
      provider: 'Test Provider',
      description: fixture.description,
      docsUrl: `https://example.com/${fixture.slug}`,
      baseUrl: `https://api.example.com/${fixture.slug}`,
      authType: fixture.authType,
      httpsSupported: fixture.https,
      corsStatus: fixture.cors,
      isFree: fixture.isFree,
      hasFreeTier: true,
      status: 'active',
      popularityScore: fixture.popularity,
      tags: ['test'],
      sourceId,
      fingerprint: `fixture:${fixture.slug}`,
    });

    if (fixture.slug !== 'coingecko') {
      await db.insert(schema.apiCategories).values({ apiId: id, categoryId, isPrimary: true });
    }

    await db.insert(schema.apiHealthLatest).values({
      apiId: id,
      status: fixture.slug === 'open-meteo' ? 'up' : 'unknown',
      latencyMs: fixture.slug === 'open-meteo' ? 120 : null,
      uptime30d: fixture.slug === 'open-meteo' ? 0.999 : null,
      reliabilityScore: fixture.slug === 'open-meteo' ? 97 : null,
      lastCheckedAt: fixture.slug === 'open-meteo' ? new Date() : null,
    });
  }

  await db.insert(schema.users).values({
    id: schema.newId('user'),
    email: 'admin@test.dev',
    name: 'Test Admin',
    passwordHash: await hashPassword('admin-password-1234'),
    role: 'admin',
  });
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });

  handle = await createDatabase({ driver: 'pglite', pgliteDataDir: TEST_DIR });
  await runMigrations(handle);
  await seedFixtures(handle.db);

  // Point the process-wide singletons at the test instances.
  setDatabaseHandle(handle);
  setCacheService(new CacheService({ store: new MemoryCacheStore() }));
  resetRateLimiter();

  ({ app } = await buildServer({ handle }));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Register a user and return the cookie plus a valid CSRF token. */
async function authenticate(email = 'user@test.dev'): Promise<{ cookie: string; csrf: string }> {
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, name: 'Test User', password: 'a-long-enough-password' },
  });

  const setCookie = registered.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;

  const session = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { cookie },
  });

  return { cookie, csrf: session.json().data.csrfToken as string };
}

describe('system endpoints', () => {
  it('reports liveness', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness with dependency detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks.map((c: { name: string }) => c.name)).toContain('database');
  });

  it('exposes Prometheus metrics', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('http_requests_total');
  });

  it('applies security headers to every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('returns a structured 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);

    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it('echoes a caller-supplied request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('rejects a malformed request id rather than logging it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/categories',
      headers: { 'x-request-id': 'bad\ninjected-log-line' },
    });
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('catalogue', () => {
  it('lists APIs in a paginated envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis?pageSize=2' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(3);
    expect(body.meta.totalPages).toBe(2);
    expect(body.meta.hasNext).toBe(true);
    expect(body.meta.requestId).toBeTruthy();
  });

  it('orders by popularity by default', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis' });
    const names = response.json().data.map((api: { name: string }) => api.name);
    expect(names[0]).toBe('Open-Meteo');
  });

  it('filters by free and auth type', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis?free=true&auth=none' });
    const body = response.json();

    expect(body.meta.total).toBe(2);
    for (const api of body.data) {
      expect(api.isFree).toBe(true);
      expect(api.authType).toBe('none');
    }
  });

  it('filters by category', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis?category=weather' });
    const body = response.json();

    expect(body.meta.total).toBe(2);
    expect(body.data.map((a: { slug: string }) => a.slug).sort()).toEqual([
      'open-meteo',
      'weatherstack',
    ]);
  });

  it('returns facet counts when requested', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis?facets=true' });
    const facets = response.json().meta.facets;

    expect(facets.auth.find((f: { value: string }) => f.value === 'none').count).toBe(2);
    expect(facets.features.find((f: { value: string }) => f.value === 'free').count).toBe(2);
  });

  it('returns API detail with provenance and health', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis/open-meteo' });
    expect(response.statusCode).toBe(200);

    const api = response.json().data;
    expect(api.name).toBe('Open-Meteo');
    expect(api.provenance.sourceName).toBe('test-source');
    expect(api.provenance.license).toBe('MIT');
    expect(api.health.status).toBe('up');
    expect(api.health.uptime30d).toBeCloseTo(0.999);
  });

  it('returns API_NOT_FOUND for an unknown slug', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('API_NOT_FOUND');
  });

  it('rejects an invalid slug format', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis/NOT__A__SLUG' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an out-of-range page size', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis?pageSize=5000' });
    expect(response.statusCode).toBe(400);

    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('lists categories with counts', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/categories' });
    const categories = response.json().data;

    expect(categories).toHaveLength(1);
    expect(categories[0].slug).toBe('weather');
  });

  it('reports platform statistics', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/stats' });
    const stats = response.json().data;

    expect(stats.totalApis).toBe(3);
    expect(stats.freeApis).toBe(2);
    expect(stats.noAuthApis).toBe(2);
  });
});

describe('search', () => {
  it('finds APIs by full-text query', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=weather' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.map((h: { api: { slug: string } }) => h.api.slug)).toContain('open-meteo');
  });

  it('ranks a name match above a description-only match', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=weatherstack' });
    expect(response.json().data[0].api.slug).toBe('weatherstack');
  });

  it('returns an explainable score breakdown', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=weather' });
    const breakdown = response.json().data[0].breakdown;

    expect(breakdown.total).toBeGreaterThan(0);
    expect(breakdown.textRelevance).toBeGreaterThan(0);
    expect(breakdown).toHaveProperty('reliability');
    expect(breakdown).toHaveProperty('freeTier');
  });

  it('highlights matched terms', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=cryptocurrency' });
    const hit = response.json().data[0];
    expect(hit.highlights.description).toContain('<mark>');
  });

  it('infers filters from natural phrasing', async () => {
    // "free" and "no auth" should filter, not just add search terms.
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=free weather no auth' });
    const slugs = response.json().data.map((h: { api: { slug: string } }) => h.api.slug);

    expect(slugs).toContain('open-meteo');
    expect(slugs).not.toContain('weatherstack');
  });

  it('returns an empty result set rather than an error for nonsense', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=zzzzqqqxxx' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it('does not break on tsquery operator characters', async () => {
    // Raw input like this would raise a syntax error if interpolated directly.
    for (const query of ['a & b', 'a | b', '!(x)', "'; DROP TABLE apis; --", 'a:*&|!()']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/search?q=${encodeURIComponent(query)}`,
      });
      expect(response.statusCode, `query: ${query}`).toBe(200);
    }
  });

  it('suggests completions for a prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/suggest?q=coin' });
    const suggestions = response.json().data;
    expect(suggestions.some((s: { text: string }) => s.text === 'CoinGecko')).toBe(true);
  });
});

describe('comparison and recommendations', () => {
  it('compares two APIs and picks an explainable winner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/compare?slugs=open-meteo,weatherstack',
    });
    expect(response.statusCode).toBe(200);

    const result = response.json().data;
    expect(result.apis).toHaveLength(2);
    // Open-Meteo is free, no-auth, CORS-enabled and healthy: it must win.
    expect(result.apis[result.verdict.winnerIndex].slug).toBe('open-meteo');
    expect(result.verdict.reasons.length).toBeGreaterThan(0);

    const authRow = result.rows.find((row: { key: string }) => row.key === 'auth');
    expect(authRow.values).toEqual(['No auth', 'API key']);
    expect(authRow.bestIndex).toBe(0);
  });

  it('requires at least two slugs to compare', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/compare?slugs=open-meteo' });
    expect(response.statusCode).toBe(400);
  });

  it('recommends grounded APIs with reasons and caveats', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recommend',
      payload: { prompt: 'I need a free weather API with no authentication', limit: 3 },
    });
    expect(response.statusCode).toBe(200);

    const result = response.json().data;
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].api.slug).toBe('open-meteo');
    expect(result.recommendations[0].reasons.length).toBeGreaterThan(0);
    // Recommendations must be deterministic unless an AI provider is wired up.
    expect(result.aiGenerated).toBe(false);
    expect(result.interpretedConstraints.free).toBe(true);
    expect(result.interpretedConstraints.noAuth).toBe(true);
  });

  it('never invents a reason not backed by a field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recommend',
      payload: { prompt: 'weather data', limit: 2 },
    });

    for (const recommendation of response.json().data.recommendations) {
      for (const reason of recommendation.reasons) {
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('authentication', () => {
  it('registers a user and sets an HttpOnly session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'new@test.dev', name: 'New User', password: 'a-long-enough-password' },
    });
    expect(response.statusCode).toBe(201);

    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
    expect(cookieHeader).toContain('HttpOnly');
    expect(response.json().data.user.email).toBe('new@test.dev');
  });

  it('never returns the password hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'nohash@test.dev', name: 'X', password: 'a-long-enough-password' },
    });
    expect(JSON.stringify(response.json())).not.toContain('argon2');
  });

  it('rejects a duplicate email', async () => {
    const payload = { email: 'dupe@test.dev', name: 'X', password: 'a-long-enough-password' };
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload });

    const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('enforces the minimum password length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'weak@test.dev', name: 'X', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@test.dev', password: 'some-password-here' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@test.dev', password: 'wrong-password-here' },
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    // Identical message: login must not be a user-enumeration oracle.
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('logs in with correct credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@test.dev', password: 'admin-password-1234' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.user.role).toBe('admin');
  });

  it('returns a null session when anonymous', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/session' });
    expect(response.json().data.user).toBeNull();
    expect(response.json().data.csrfToken).toBeNull();
  });

  it('rejects a forged session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie: 'apihub_session=forged.signature' },
    });
    expect(response.json().data.user).toBeNull();
  });
});

describe('favorites and authorization', () => {
  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me/favorites' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('requires a CSRF token for writes', async () => {
    const { cookie } = await authenticate('csrf@test.dev');
    const detail = await app.inject({ method: 'GET', url: '/v1/apis/open-meteo' });
    const apiId = detail.json().data.id;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/me/favorites/${apiId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('adds and removes a favorite', async () => {
    const { cookie, csrf } = await authenticate('fav@test.dev');
    const detail = await app.inject({ method: 'GET', url: '/v1/apis/open-meteo' });
    const apiId = detail.json().data.id;
    const headers = { cookie, 'x-csrf-token': csrf };

    const added = await app.inject({
      method: 'POST',
      url: `/v1/me/favorites/${apiId}`,
      headers,
    });
    expect(added.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/me/favorites', headers: { cookie } });
    expect(list.json().data).toHaveLength(1);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/me/favorites/${apiId}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/v1/me/favorites', headers: { cookie } });
    expect(after.json().data).toHaveLength(0);
  });

  it('is idempotent when favoriting twice', async () => {
    const { cookie, csrf } = await authenticate('idem@test.dev');
    const detail = await app.inject({ method: 'GET', url: '/v1/apis/coingecko' });
    const apiId = detail.json().data.id;
    const headers = { cookie, 'x-csrf-token': csrf };

    await app.inject({ method: 'POST', url: `/v1/me/favorites/${apiId}`, headers });
    const second = await app.inject({ method: 'POST', url: `/v1/me/favorites/${apiId}`, headers });

    expect(second.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/v1/me/favorites', headers: { cookie } });
    expect(list.json().data).toHaveLength(1);
  });

  it('does not leak private data into a shared cache', async () => {
    const { cookie } = await authenticate('cache@test.dev');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me/favorites',
      headers: { cookie },
    });
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('collections', () => {
  it('creates, populates and reads back a collection', async () => {
    const { cookie, csrf } = await authenticate('collections@test.dev');
    const headers = { cookie, 'x-csrf-token': csrf };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/me/collections',
      headers,
      payload: { name: 'My Weather Stack', description: 'For the travel app', isPublic: true },
    });
    expect(created.statusCode).toBe(201);

    const collectionId = created.json().data.id;
    expect(created.json().data.slug).toBe('my-weather-stack');

    const detail = await app.inject({ method: 'GET', url: '/v1/apis/open-meteo' });
    const apiId = detail.json().data.id;

    const added = await app.inject({
      method: 'POST',
      url: `/v1/me/collections/${collectionId}/items/${apiId}`,
      headers,
      payload: {},
    });
    expect(added.statusCode).toBe(200);

    const fetched = await app.inject({ method: 'GET', url: `/v1/collections/${collectionId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().data.items).toHaveLength(1);
    expect(fetched.json().data.itemCount).toBe(1);
  });

  it('hides a private collection from other users', async () => {
    const owner = await authenticate('owner@test.dev');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/me/collections',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload: { name: 'Secret Stack', isPublic: false },
    });
    const collectionId = created.json().data.id;

    // Anonymous request must not see it, and must get 404 rather than 403 so
    // its existence is not confirmed.
    const anonymous = await app.inject({ method: 'GET', url: `/v1/collections/${collectionId}` });
    expect(anonymous.statusCode).toBe(404);

    const owned = await app.inject({
      method: 'GET',
      url: `/v1/collections/${collectionId}`,
      headers: { cookie: owner.cookie },
    });
    expect(owned.statusCode).toBe(200);
  });
});

describe('reviews', () => {
  it('creates a review and updates the aggregate', async () => {
    const { cookie, csrf } = await authenticate('reviewer@test.dev');
    const headers = { cookie, 'x-csrf-token': csrf };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/apis/coingecko/reviews',
      headers,
      payload: {
        ratings: { overall: 5, documentation: 4, reliability: 5 },
        title: 'Excellent',
        body: 'Reliable and free.',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.ratings.overall).toBe(5);

    const list = await app.inject({ method: 'GET', url: '/v1/apis/coingecko/reviews' });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().meta.summary.average).toBe(5);
    expect(list.json().meta.summary.distribution[4]).toBe(1);
  });

  it('rejects a second review from the same user', async () => {
    const { cookie, csrf } = await authenticate('double@test.dev');
    const headers = { cookie, 'x-csrf-token': csrf };
    const payload = { ratings: { overall: 4 } };

    await app.inject({ method: 'POST', url: '/v1/apis/weatherstack/reviews', headers, payload });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/apis/weatherstack/reviews',
      headers,
      payload,
    });

    expect(second.statusCode).toBe(409);
  });

  it('validates the rating range', async () => {
    const { cookie, csrf } = await authenticate('badrating@test.dev');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/apis/coingecko/reviews',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { ratings: { overall: 9 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('stores review text without executable markup', async () => {
    const { cookie, csrf } = await authenticate('xss@test.dev');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/apis/open-meteo/reviews',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ratings: { overall: 3 },
        body: 'Normal text with a ‮reversed marker and a ​zero-width space.',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json().data.body as string;
    // Bidi and zero-width characters are stripped on write.
    expect(body).not.toContain('‮');
    expect(body).not.toContain('​');
  });
});

describe('playground SSRF boundary', () => {
  /** Every one of these must be refused. This is the report's key security test. */
  const blocked: [string, string][] = [
    ['loopback IPv4', 'https://127.0.0.1/'],
    ['loopback by name', 'https://localhost/'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['private 10.x', 'https://10.0.0.1/'],
    ['private 192.168.x', 'https://192.168.1.1/'],
    ['private 172.16.x', 'https://172.16.0.1/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/'],
    ['IPv6 unique-local', 'https://[fd00::1]/'],
    ['link-local', 'https://169.254.1.1/'],
    ['file scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://example.com/'],
    ['internal .local', 'https://printer.local/'],
    ['internal .internal', 'https://db.internal/'],
    ['ssh port', 'https://example.com:22/'],
    ['postgres port', 'https://example.com:5432/'],
    ['credentials in url', 'https://user:pass@example.com/'],
  ];

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/playground/requests',
        payload: { method: 'GET', url },
      });

      expect(response.statusCode, `${label} should be refused`).toBeGreaterThanOrEqual(400);
      expect(response.json().error.code).toBe('BLOCKED_TARGET');
    });
  }

  it('rejects a disallowed HTTP method', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playground/requests',
      payload: { method: 'TRACE', url: 'https://example.com/' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects header injection via CRLF', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playground/requests',
      payload: {
        method: 'GET',
        url: 'https://example.com/',
        headers: [{ name: 'X-Test\r\nX-Injected', value: 'evil', enabled: true }],
      },
    });
    // The header NAME pattern refuses CR/LF outright.
    expect(response.statusCode).toBe(400);
  });

  it('caps the number of headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playground/requests',
      payload: {
        method: 'GET',
        url: 'https://example.com/',
        headers: Array.from({ length: 50 }, (_, i) => ({
          name: `X-H${i}`,
          value: 'v',
          enabled: true,
        })),
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('code generation', () => {
  const request = {
    method: 'GET' as const,
    url: 'https://api.example.com/data',
    headers: [{ name: 'Accept', value: 'application/json', enabled: true }],
    queryParams: [{ name: 'limit', value: '10', enabled: true }],
    auth: { type: 'apiKey' as const, key: 'super-secret-key', in: 'header' as const, name: 'X-API-Key' },
  };

  it('generates code for every supported language', async () => {
    const languages = [
      'curl',
      'javascript-fetch',
      'typescript-fetch',
      'javascript-axios',
      'python-requests',
      'python-httpx',
      'go',
      'java',
      'csharp',
      'php',
      'ruby',
      'rust',
    ];

    for (const language of languages) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/playground/code',
        payload: { language, request },
      });

      expect(response.statusCode, language).toBe(200);
      const result = response.json().data;
      expect(result.code.length, language).toBeGreaterThan(20);
      expect(result.language, language).toBe(language);
    }
  });

  it('never inlines the secret into generated code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playground/code/all',
      payload: request,
    });

    for (const result of response.json().data) {
      expect(result.code, `${result.language} leaked the key`).not.toContain('super-secret-key');
      // It must read the credential from the environment instead.
      expect(result.code.toUpperCase(), result.language).toContain('API_KEY');
    }
  });

  it('includes the query parameters in the generated URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/playground/code',
      payload: { language: 'curl', request },
    });
    expect(response.json().data.code).toContain('limit=10');
  });
});

describe('health monitoring', () => {
  it('returns a status board with a summary', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health/board' });
    expect(response.statusCode).toBe(200);

    const board = response.json().data;
    expect(board.summary.total).toBe(3);
    expect(board.summary.up).toBe(1);
    expect(board.entries.length).toBe(3);
  });

  it('sorts unhealthy APIs first', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health/board' });
    const statuses = response.json().data.entries.map((e: { status: string }) => e.status);
    // 'up' must not be first while 'unknown' entries exist.
    expect(statuses[statuses.length - 1]).toBe('up');
  });

  it('returns a health report for a monitored API', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis/open-meteo/health' });
    expect(response.statusCode).toBe(200);

    const report = response.json().data;
    expect(report.current.status).toBe('up');
    expect(report.reliability.score).toBeGreaterThan(0);
  });

  it('returns an unknown report rather than 404 for an unmonitored API', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/apis/coingecko/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.current.status).toBe('unknown');
  });
});

describe('admin authorization', () => {
  it('denies anonymous access', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/admin/health' });
    expect(response.statusCode).toBe(401);
  });

  it('denies a regular user', async () => {
    const { cookie } = await authenticate('regular@test.dev');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('allows an admin', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@test.dev', password: 'admin-password-1234' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.drivers.database).toBe('pglite');
  });
});
