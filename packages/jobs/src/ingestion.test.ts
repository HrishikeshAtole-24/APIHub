/**
 * Ingestion pipeline tests (report 28.1: "Ingestion idempotency" and "URL
 * canonicalization" are minimum coverage priorities).
 *
 * These cover the pure stages — parse, normalize, canonicalize, deduplicate —
 * which is where the correctness actually lives. Persistence is exercised by
 * the database integration tests.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalizeUrl,
  deriveTags,
  findDuplicateClusters,
  fingerprintOf,
  hostOf,
  initialPopularity,
  normalize,
  normalizeAuthType,
  normalizeCors,
  resolveSlugCollisions,
  type NormalizedApi,
} from './ingestion/normalizer.js';
import { PublicApisMarkdownAdapter } from './ingestion/source-adapter.js';

const adapter = new PublicApisMarkdownAdapter('https://example.com/README.md');

describe('PublicApisMarkdownAdapter', () => {
  const README = `
# Public APIs

## Index

### Animals

API | Description | Auth | HTTPS | CORS
|---|---|---|---|---|
| [Cat Facts](https://catfact.ninja/) | Daily cat facts | No | Yes | No |
| [Dog CEO](https://dog.ceo/dog-api/) | Dog images by breed | No | Yes | Yes |

### Weather

API | Description | Auth | HTTPS | CORS
|---|---|---|---|---|
| [OpenWeatherMap](https://openweathermap.org/api) | Weather data | apiKey | Yes | Yes |

## License

MIT
`;

  it('extracts records with their category', () => {
    const { records } = adapter.parse(README);

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      name: 'Cat Facts',
      url: 'https://catfact.ninja/',
      category: 'Animals',
      auth: 'No',
      https: true,
      cors: 'no',
    });
    expect(records[2]?.category).toBe('Weather');
  });

  it('stops collecting at a non-category heading', () => {
    // "## License" ends the catalogue; nothing after it should be a record.
    const { records } = adapter.parse(README);
    expect(records.every((record) => record.category !== 'License')).toBe(true);
  });

  it('reports malformed rows instead of throwing', () => {
    const broken = `
### Broken

API | Description | Auth | HTTPS | CORS
|---|---|---|---|---|
| Not a link | missing url | No | Yes | Yes |
| [Too few columns](https://example.com) | only three |
`;
    const { records, failures } = adapter.parse(broken);

    expect(records).toHaveLength(0);
    expect(failures).toHaveLength(2);
    expect(failures[0]?.reason).toContain('documentation URL');
  });

  it('handles an empty document', () => {
    expect(adapter.parse('').records).toHaveLength(0);
  });

  it('strips markdown emphasis from descriptions', () => {
    const source = `
### Test

API | Description | Auth | HTTPS | CORS
|---|---|---|---|---|
| [Thing](https://example.com) | A **bold** and *italic* description | No | Yes | Yes |
`;
    expect(adapter.parse(source).records[0]?.description).toBe(
      'A bold and italic description',
    );
  });
});

describe('normalizeAuthType', () => {
  it('maps the inconsistent upstream values onto our enum', () => {
    expect(normalizeAuthType('')).toBe('none');
    expect(normalizeAuthType('No')).toBe('none');
    expect(normalizeAuthType('apiKey')).toBe('apiKey');
    expect(normalizeAuthType('API Key')).toBe('apiKey');
    expect(normalizeAuthType('X-Mashape-Key')).toBe('apiKey');
    expect(normalizeAuthType('OAuth')).toBe('oauth2');
    expect(normalizeAuthType('OAuth 1.0')).toBe('oauth');
    expect(normalizeAuthType('`apiKey`')).toBe('apiKey');
  });
});

describe('normalizeCors', () => {
  it('collapses anything unrecognised to unknown', () => {
    expect(normalizeCors('Yes')).toBe('yes');
    expect(normalizeCors('no')).toBe('no');
    expect(normalizeCors('Unknown')).toBe('unknown');
    expect(normalizeCors('')).toBe('unknown');
  });
});

describe('canonicalizeUrl', () => {
  it('lowercases the host and strips www', () => {
    expect(canonicalizeUrl('https://WWW.Example.com/Docs')).toBe('https://example.com/Docs');
  });

  it('removes default ports', () => {
    expect(canonicalizeUrl('https://example.com:443/api')).toBe('https://example.com/api');
    expect(canonicalizeUrl('http://example.com:80/api')).toBe('http://example.com/api');
  });

  it('keeps a non-default port', () => {
    expect(canonicalizeUrl('https://example.com:8443/api')).toContain(':8443');
  });

  it('drops fragments and trailing slashes', () => {
    expect(canonicalizeUrl('https://example.com/docs/#section')).toBe('https://example.com/docs');
  });

  it('strips tracking parameters but keeps meaningful ones', () => {
    const result = canonicalizeUrl('https://example.com/?utm_source=x&page=2&ref=y');
    expect(result).toContain('page=2');
    expect(result).not.toContain('utm_source');
    expect(result).not.toContain('ref=');
  });

  it('rejects non-http protocols and malformed input', () => {
    expect(canonicalizeUrl('ftp://example.com')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('is deterministic — the fingerprint depends on it', () => {
    const variants = [
      'https://WWW.Example.com:443/docs/',
      'https://example.com/docs',
      'https://www.example.com/docs/#top',
    ];
    const canonical = variants.map((url) => canonicalizeUrl(url));
    expect(new Set(canonical).size).toBe(1);
  });
});

describe('fingerprintOf', () => {
  it('is stable for the same input', () => {
    const a = fingerprintOf('public-apis', 'https://example.com/docs', 'Example API');
    const b = fingerprintOf('public-apis', 'https://example.com/docs', 'Example API');
    expect(a).toBe(b);
  });

  it('differs for different APIs', () => {
    const a = fingerprintOf('public-apis', 'https://example.com/docs', 'Example API');
    const b = fingerprintOf('public-apis', 'https://other.com/docs', 'Other API');
    expect(a).not.toBe(b);
  });

  it('is unaffected by name casing or spacing', () => {
    // Slugified internally, so cosmetic upstream edits do not create a new row.
    const a = fingerprintOf('public-apis', 'https://example.com', 'Example API');
    const b = fingerprintOf('public-apis', 'https://example.com', 'example   api');
    expect(a).toBe(b);
  });
});

describe('normalize', () => {
  const record = {
    name: 'Open-Meteo',
    description: 'Free weather forecast API',
    url: 'https://open-meteo.com/en/docs',
    category: 'Weather',
    auth: '',
    https: true,
    cors: 'yes',
  };

  it('produces a complete normalised record', () => {
    const result = normalize(record, 'public-apis');

    expect(result).not.toBeNull();
    expect(result?.slug).toBe('open-meteo');
    expect(result?.authType).toBe('none');
    expect(result?.isFree).toBe(true);
    expect(result?.provider).toBe('open-meteo.com');
    expect(result?.categorySlug).toBe('weather');
  });

  it('does not invent a base URL', () => {
    // Upstream gives a documentation URL, not an API base. Guessing one would
    // be fabricating data.
    expect(normalize(record, 'public-apis')?.baseUrl).toBeNull();
  });

  it('returns null when the URL cannot be canonicalised', () => {
    expect(normalize({ ...record, url: 'not-a-url' }, 'public-apis')).toBeNull();
  });

  it('returns null for an empty name', () => {
    expect(normalize({ ...record, name: '   ' }, 'public-apis')).toBeNull();
  });

  it('is idempotent — same input, same fingerprint', () => {
    const a = normalize(record, 'public-apis');
    const b = normalize(record, 'public-apis');
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });
});

describe('initialPopularity', () => {
  const record = {
    name: 'X',
    description: 'A reasonably detailed description of this API service',
    url: 'https://example.com',
    category: 'Test',
    auth: '',
    https: true,
    cors: 'yes',
  };

  it('rewards APIs that are easier to adopt', () => {
    const noAuth = initialPopularity(record, 'none');
    const withKey = initialPopularity(record, 'apiKey');
    expect(noAuth).toBeGreaterThan(withKey);
  });

  it('stays within 0..100', () => {
    const value = initialPopularity(
      { ...record, url: 'https://api.github.com' },
      'none',
    );
    expect(value).toBeLessThanOrEqual(100);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});

describe('deriveTags', () => {
  it('derives tags from category and capabilities', () => {
    const tags = deriveTags(
      {
        name: 'Test',
        description: 'A free realtime JSON API',
        url: 'https://example.com',
        category: 'Machine Learning',
        auth: '',
        https: true,
        cors: 'yes',
      },
      'none',
    );

    expect(tags).toContain('machine-learning');
    expect(tags).toContain('no-key');
    expect(tags).toContain('https');
    expect(tags).toContain('cors');
    expect(tags.length).toBeLessThanOrEqual(8);
  });
});

describe('hostOf', () => {
  it('extracts a normalised host', () => {
    expect(hostOf('https://WWW.Example.com/path')).toBe('example.com');
    expect(hostOf('nonsense')).toBeNull();
  });
});

describe('resolveSlugCollisions', () => {
  const make = (name: string, slug: string, provider: string): NormalizedApi => ({
    fingerprint: `fp-${name}`,
    slug,
    name,
    provider,
    description: '',
    docsUrl: `https://${provider}/docs`,
    baseUrl: null,
    authType: 'none',
    httpsSupported: true,
    corsStatus: 'yes',
    isFree: true,
    hasFreeTier: true,
    categorySlug: 'test',
    categoryName: 'Test',
    tags: [],
    popularityScore: 50,
  });

  it('leaves unique slugs untouched', () => {
    const result = resolveSlugCollisions([
      make('A', 'alpha', 'a.com'),
      make('B', 'beta', 'b.com'),
    ]);
    expect(result.map((entry) => entry.slug)).toEqual(['alpha', 'beta']);
  });

  it('disambiguates a collision within the batch', () => {
    const result = resolveSlugCollisions([
      make('Weather', 'weather', 'one.com'),
      make('Weather', 'weather', 'two.com'),
    ]);

    expect(result[0]?.slug).toBe('weather');
    expect(result[1]?.slug).not.toBe('weather');
    expect(new Set(result.map((entry) => entry.slug)).size).toBe(2);
  });

  it('disambiguates against slugs already in the database', () => {
    // The real bug this guards: an earlier version only deduplicated within the
    // batch, so a re-import collided with rows from a previous run.
    const reserved = new Map([['weather', 'some-other-fingerprint']]);
    const result = resolveSlugCollisions([make('Weather', 'weather', 'one.com')], reserved);

    expect(result[0]?.slug).not.toBe('weather');
  });

  it('lets a record keep its slug when the fingerprint matches', () => {
    // Same API being updated, not a genuine collision.
    const api = make('Weather', 'weather', 'one.com');
    const reserved = new Map([['weather', api.fingerprint]]);

    expect(resolveSlugCollisions([api], reserved)[0]?.slug).toBe('weather');
  });

  it('always produces unique slugs even under heavy collision', () => {
    const items = Array.from({ length: 60 }, (_, i) => make(`API ${i}`, 'same', `host${i}.com`));
    const result = resolveSlugCollisions(items);
    expect(new Set(result.map((entry) => entry.slug)).size).toBe(60);
  });
});

describe('findDuplicateClusters', () => {
  const make = (fingerprint: string, slug: string, provider: string, docsUrl: string): NormalizedApi => ({
    fingerprint,
    slug,
    name: slug,
    provider,
    description: '',
    docsUrl,
    baseUrl: null,
    authType: 'none',
    httpsSupported: true,
    corsStatus: 'yes',
    isFree: true,
    hasFreeTier: true,
    categorySlug: 'test',
    categoryName: 'Test',
    tags: [],
    popularityScore: 50,
  });

  it('clusters records sharing a documentation URL', () => {
    const clusters = findDuplicateClusters([
      make('a', 'openweather', 'openweathermap.org', 'https://openweathermap.org/api'),
      make('b', 'open-weather', 'openweathermap.org', 'https://openweathermap.org/api'),
      make('c', 'coingecko', 'coingecko.com', 'https://coingecko.com/api'),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it('does not cluster genuinely different APIs', () => {
    const clusters = findDuplicateClusters([
      make('a', 'alpha', 'alpha.com', 'https://alpha.com'),
      make('b', 'beta', 'beta.com', 'https://beta.com'),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('never merges automatically — it only reports candidates', () => {
    // Report 16.2: fuzzy matching is a REVIEW signal, never a destructive merge.
    const input = [
      make('a', 'weather-api', 'example.com', 'https://example.com/1'),
      make('b', 'weather-apis', 'example.com', 'https://example.com/2'),
    ];
    const clusters = findDuplicateClusters(input);

    // The function returns ids to review; the input is untouched.
    expect(input).toHaveLength(2);
    expect(clusters.flat().every((id) => typeof id === 'string')).toBe(true);
  });
});
