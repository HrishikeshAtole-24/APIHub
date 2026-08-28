/**
 * `pnpm db:seed` — populate a development database.
 *
 * Seeding is idempotent: every insert is an upsert keyed on a stable
 * fingerprint, so running it repeatedly converges rather than duplicating.
 * That mirrors the real ingestion pipeline's contract (report 16.3).
 *
 * The data below is a curated, hand-verified subset of the public-apis
 * catalogue. It exists so that a fresh clone has a browsable, searchable,
 * demonstrable product immediately, without waiting on a network import.
 */
import { slugify } from '@apihub/algorithms';
import { hashPassword } from '@apihub/security';
import { sql } from 'drizzle-orm';

import { createDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';
import * as schema from '../schema/index.js';

interface SeedApi {
  name: string;
  provider: string;
  description: string;
  longDescription?: string;
  category: string;
  docsUrl: string;
  baseUrl: string;
  authType: string;
  https: boolean;
  cors: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  hasFreeTier: boolean;
  popularity: number;
  tags: string[];
  probePath?: string;
}

const CATEGORIES: { slug: string; name: string; description: string; icon: string }[] = [
  { slug: 'weather', name: 'Weather', description: 'Forecasts, current conditions and climate data', icon: 'cloud-sun' },
  { slug: 'finance', name: 'Finance & Crypto', description: 'Markets, currencies, payments and cryptocurrency', icon: 'trending-up' },
  { slug: 'geocoding', name: 'Geocoding & Maps', description: 'Addresses, coordinates, routing and places', icon: 'map-pin' },
  { slug: 'development', name: 'Development', description: 'Tools for building and testing software', icon: 'code' },
  { slug: 'science', name: 'Science & Space', description: 'Astronomy, research data and open science', icon: 'rocket' },
  { slug: 'animals', name: 'Animals', description: 'Facts, images and data about animals', icon: 'paw-print' },
  { slug: 'entertainment', name: 'Entertainment', description: 'Film, music, games and media', icon: 'clapperboard' },
  { slug: 'news', name: 'News', description: 'Headlines, articles and publications', icon: 'newspaper' },
  { slug: 'transport', name: 'Transport & Travel', description: 'Flights, transit, vehicles and travel', icon: 'plane' },
  { slug: 'government', name: 'Government & Open Data', description: 'Public records and open government data', icon: 'landmark' },
  { slug: 'health', name: 'Health', description: 'Medical, fitness and nutrition data', icon: 'heart-pulse' },
  { slug: 'text', name: 'Text & Language', description: 'Translation, dictionaries and text processing', icon: 'languages' },
];

const APIS: SeedApi[] = [
  {
    name: 'Open-Meteo', provider: 'Open-Meteo', category: 'weather',
    description: 'Free weather forecast API with no API key required, offering hourly and daily forecasts worldwide.',
    longDescription: 'Open-Meteo is an open-source weather API offering free access for non-commercial use. It combines local and global weather models to deliver forecasts at up to 1km resolution, with no registration and no API key.',
    docsUrl: 'https://open-meteo.com/en/docs', baseUrl: 'https://api.open-meteo.com/v1',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 95,
    tags: ['weather', 'forecast', 'no-key', 'free'],
    probePath: '/forecast?latitude=52.52&longitude=13.41&current_weather=true',
  },
  {
    name: 'OpenWeatherMap', provider: 'OpenWeather Ltd', category: 'weather',
    description: 'Current weather, forecasts and historical data for any location, with a generous free tier.',
    docsUrl: 'https://openweathermap.org/api', baseUrl: 'https://api.openweathermap.org/data/2.5',
    authType: 'apiKey', https: true, cors: 'yes', isFree: false, hasFreeTier: true, popularity: 92,
    tags: ['weather', 'forecast', 'historical'],
  },
  {
    name: 'CoinGecko', provider: 'CoinGecko', category: 'finance',
    description: 'Cryptocurrency prices, market capitalisation and exchange data for thousands of coins.',
    longDescription: 'CoinGecko provides comprehensive cryptocurrency market data including price, volume, market cap, exchange listings and historical charts. The public API requires no key for basic endpoints.',
    docsUrl: 'https://www.coingecko.com/en/api/documentation', baseUrl: 'https://api.coingecko.com/api/v3',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 90,
    tags: ['crypto', 'bitcoin', 'market-data', 'no-key'], probePath: '/ping',
  },
  {
    name: 'Frankfurter', provider: 'Frankfurter', category: 'finance',
    description: 'Free currency exchange rates published by the European Central Bank, with historical data.',
    docsUrl: 'https://www.frankfurter.app/docs', baseUrl: 'https://api.frankfurter.app',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 74,
    tags: ['currency', 'exchange-rate', 'forex', 'no-key'], probePath: '/latest',
  },
  {
    name: 'Exchangerate.host', provider: 'exchangerate.host', category: 'finance',
    description: 'Foreign exchange rates, currency conversion and cryptocurrency rates.',
    docsUrl: 'https://exchangerate.host/#/docs', baseUrl: 'https://api.exchangerate.host',
    authType: 'apiKey', https: true, cors: 'yes', isFree: false, hasFreeTier: true, popularity: 70,
    tags: ['currency', 'conversion', 'forex'],
  },
  {
    name: 'Nominatim', provider: 'OpenStreetMap Foundation', category: 'geocoding',
    description: 'Geocoding and reverse geocoding built on OpenStreetMap data.',
    longDescription: 'Nominatim searches OpenStreetMap data by name and address (geocoding) and generates addresses from coordinates (reverse geocoding). Usage of the public instance is subject to a strict fair-use policy.',
    docsUrl: 'https://nominatim.org/release-docs/latest/api/Overview/', baseUrl: 'https://nominatim.openstreetmap.org',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 82,
    tags: ['geocoding', 'maps', 'openstreetmap', 'no-key'], probePath: '/status',
  },
  {
    name: 'IP API', provider: 'ip-api.com', category: 'geocoding',
    description: 'IP address geolocation returning country, region, city, latitude and longitude.',
    docsUrl: 'https://ip-api.com/docs', baseUrl: 'http://ip-api.com/json',
    authType: 'none', https: false, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 68,
    tags: ['ip', 'geolocation', 'no-key'],
  },
  {
    name: 'JSONPlaceholder', provider: 'JSONPlaceholder', category: 'development',
    description: 'Fake REST API for prototyping and testing, with posts, comments, users and todos.',
    longDescription: 'JSONPlaceholder is a free online REST API you can use whenever you need fake data. It supports GET, POST, PUT, PATCH and DELETE, making it ideal for tutorials and front-end prototyping.',
    docsUrl: 'https://jsonplaceholder.typicode.com/', baseUrl: 'https://jsonplaceholder.typicode.com',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 88,
    tags: ['testing', 'mock', 'prototyping', 'no-key'], probePath: '/posts/1',
  },
  {
    name: 'httpbin', provider: 'Kenneth Reitz', category: 'development',
    description: 'HTTP request and response testing service that echoes back everything you send it.',
    docsUrl: 'https://httpbin.org/', baseUrl: 'https://httpbin.org',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 80,
    tags: ['testing', 'http', 'debugging', 'no-key'], probePath: '/get',
  },
  {
    name: 'GitHub REST API', provider: 'GitHub', category: 'development',
    description: 'Access repositories, issues, pull requests, users and everything else on GitHub.',
    longDescription: 'The GitHub REST API exposes the full GitHub platform: repositories, commits, issues, pull requests, actions, releases and organisations. Unauthenticated requests are limited to 60 per hour; a token raises this to 5,000.',
    docsUrl: 'https://docs.github.com/en/rest', baseUrl: 'https://api.github.com',
    authType: 'oauth2', https: true, cors: 'yes', isFree: false, hasFreeTier: true, popularity: 96,
    tags: ['git', 'repositories', 'developer-tools'], probePath: '/zen',
  },
  {
    name: 'Public APIs', provider: 'public-apis', category: 'development',
    description: 'A directory API listing hundreds of free public APIs by category.',
    docsUrl: 'https://api.publicapis.org/', baseUrl: 'https://api.publicapis.org',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 62,
    tags: ['directory', 'catalog', 'no-key'],
  },
  {
    name: 'NASA Open APIs', provider: 'NASA', category: 'science',
    description: 'Astronomy Picture of the Day, Mars rover photos, near-Earth objects and Earth imagery.',
    longDescription: 'NASA provides a collection of open APIs including APOD (Astronomy Picture of the Day), Mars Rover Photos, NeoWs for near-Earth asteroids, EPIC Earth imagery and the Earth Observatory Natural Event Tracker.',
    docsUrl: 'https://api.nasa.gov/', baseUrl: 'https://api.nasa.gov',
    authType: 'apiKey', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 86,
    tags: ['space', 'astronomy', 'images', 'nasa'],
  },
  {
    name: 'Open Notify', provider: 'Open Notify', category: 'science',
    description: 'Current location of the International Space Station and how many people are in space.',
    docsUrl: 'http://open-notify.org/Open-Notify-API/', baseUrl: 'http://api.open-notify.org',
    authType: 'none', https: false, cors: 'no', isFree: true, hasFreeTier: true, popularity: 55,
    tags: ['space', 'iss', 'no-key'],
  },
  {
    name: 'Dog CEO', provider: 'Dog CEO', category: 'animals',
    description: 'Thousands of dog images sorted by breed, from the Stanford Dogs Dataset.',
    docsUrl: 'https://dog.ceo/dog-api/', baseUrl: 'https://dog.ceo/api',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 66,
    tags: ['dogs', 'images', 'fun', 'no-key'], probePath: '/breeds/list/all',
  },
  {
    name: 'Cat Facts', provider: 'Alex Wohlbruck', category: 'animals',
    description: 'Random facts about cats, served as plain JSON with no authentication.',
    docsUrl: 'https://alexwohlbruck.github.io/cat-facts/', baseUrl: 'https://cat-fact.herokuapp.com',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 48,
    tags: ['cats', 'facts', 'fun', 'no-key'],
  },
  {
    name: 'PokéAPI', provider: 'PokéAPI', category: 'entertainment',
    description: 'Comprehensive Pokémon data: species, moves, abilities, types and evolution chains.',
    longDescription: 'PokéAPI serves detailed data on every Pokémon, including stats, types, abilities, moves, evolution chains, items and locations. It is free, requires no key, and asks only that you cache responses.',
    docsUrl: 'https://pokeapi.co/docs/v2', baseUrl: 'https://pokeapi.co/api/v2',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 84,
    tags: ['games', 'pokemon', 'no-key'], probePath: '/pokemon/ditto',
  },
  {
    name: 'TVMaze', provider: 'TVMaze', category: 'entertainment',
    description: 'TV show schedules, episodes, cast and network information.',
    docsUrl: 'https://www.tvmaze.com/api', baseUrl: 'https://api.tvmaze.com',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 64,
    tags: ['tv', 'shows', 'episodes', 'no-key'], probePath: '/shows/1',
  },
  {
    name: 'The Movie Database', provider: 'TMDB', category: 'entertainment',
    description: 'Films, TV shows, cast, crew, posters and ratings from a large community database.',
    docsUrl: 'https://developer.themoviedb.org/docs', baseUrl: 'https://api.themoviedb.org/3',
    authType: 'apiKey', https: true, cors: 'yes', isFree: false, hasFreeTier: true, popularity: 87,
    tags: ['movies', 'tv', 'entertainment'],
  },
  {
    name: 'Hacker News API', provider: 'Y Combinator', category: 'news',
    description: 'Stories, comments, jobs and user profiles from Hacker News in near real time.',
    docsUrl: 'https://github.com/HackerNews/API', baseUrl: 'https://hacker-news.firebaseio.com/v0',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 78,
    tags: ['news', 'tech', 'no-key'], probePath: '/maxitem.json',
  },
  {
    name: 'NewsAPI', provider: 'NewsAPI.org', category: 'news',
    description: 'Headlines and articles from thousands of news sources and blogs worldwide.',
    docsUrl: 'https://newsapi.org/docs', baseUrl: 'https://newsapi.org/v2',
    authType: 'apiKey', https: true, cors: 'no', isFree: false, hasFreeTier: true, popularity: 76,
    tags: ['news', 'headlines', 'articles'],
  },
  {
    name: 'REST Countries', provider: 'REST Countries', category: 'government',
    description: 'Country data including population, currencies, languages, flags and borders.',
    docsUrl: 'https://restcountries.com/', baseUrl: 'https://restcountries.com/v3.1',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 81,
    tags: ['countries', 'geography', 'reference', 'no-key'], probePath: '/name/india',
  },
  {
    name: 'Open Library', provider: 'Internet Archive', category: 'government',
    description: 'Bibliographic data for millions of books, authors, editions and covers.',
    docsUrl: 'https://openlibrary.org/developers/api', baseUrl: 'https://openlibrary.org',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 69,
    tags: ['books', 'library', 'open-data', 'no-key'],
  },
  {
    name: 'Open Food Facts', provider: 'Open Food Facts', category: 'health',
    description: 'Nutrition and ingredient data for millions of food products worldwide.',
    docsUrl: 'https://openfoodfacts.github.io/openfoodfacts-server/api/', baseUrl: 'https://world.openfoodfacts.org',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 63,
    tags: ['food', 'nutrition', 'open-data', 'no-key'],
  },
  {
    name: 'disease.sh', provider: 'disease.sh', category: 'health',
    description: 'Open disease and epidemiology data, including historical COVID-19 statistics.',
    docsUrl: 'https://disease.sh/docs/', baseUrl: 'https://disease.sh/v3',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 58,
    tags: ['health', 'epidemiology', 'statistics', 'no-key'],
  },
  {
    name: 'Aviationstack', provider: 'apilayer', category: 'transport',
    description: 'Real-time flight status, schedules, routes and airline information.',
    docsUrl: 'https://aviationstack.com/documentation', baseUrl: 'https://api.aviationstack.com/v1',
    authType: 'apiKey', https: true, cors: 'no', isFree: false, hasFreeTier: true, popularity: 72,
    tags: ['flights', 'aviation', 'travel'],
  },
  {
    name: 'Transport for London', provider: 'TfL', category: 'transport',
    description: 'Live London transport data: tube status, bus arrivals, journey planning and cycle hire.',
    docsUrl: 'https://api.tfl.gov.uk/', baseUrl: 'https://api.tfl.gov.uk',
    authType: 'apiKey', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 60,
    tags: ['transit', 'london', 'transport', 'open-data'],
  },
  {
    name: 'LibreTranslate', provider: 'LibreTranslate', category: 'text',
    description: 'Free and open-source machine translation between dozens of languages.',
    docsUrl: 'https://libretranslate.com/docs/', baseUrl: 'https://libretranslate.com',
    authType: 'apiKey', https: true, cors: 'yes', isFree: false, hasFreeTier: true, popularity: 67,
    tags: ['translation', 'language', 'nlp', 'open-source'],
  },
  {
    name: 'Free Dictionary API', provider: 'meetDeveloper', category: 'text',
    description: 'English word definitions, phonetics, synonyms and usage examples.',
    docsUrl: 'https://dictionaryapi.dev/', baseUrl: 'https://api.dictionaryapi.dev/api/v2',
    authType: 'none', https: true, cors: 'yes', isFree: true, hasFreeTier: true, popularity: 71,
    tags: ['dictionary', 'language', 'definitions', 'no-key'],
    probePath: '/entries/en/hello',
  },
];

async function main(): Promise<void> {
  const handle = await createDatabase();
  const { db } = handle;

  try {
    console.log('APIHub seed');
    await runMigrations(handle, { log: (m) => console.log(`  ${m}`) });

    // ── Source (provenance, report 16.1) ────────────────────
    const sourceId = schema.deterministicId('source', 'public-apis');
    await db
      .insert(schema.apiSources)
      .values({
        id: sourceId,
        name: 'public-apis',
        url: 'https://github.com/public-apis/public-apis',
        license: 'MIT',
        transformVersion: '1',
      })
      .onConflictDoNothing();

    // ── Categories ──────────────────────────────────────────
    const categoryIds = new Map<string, string>();
    for (const category of CATEGORIES) {
      const id = schema.deterministicId('category', category.slug);
      categoryIds.set(category.slug, id);

      await db
        .insert(schema.categories)
        .values({ id, ...category })
        .onConflictDoUpdate({
          target: schema.categories.slug,
          set: { name: category.name, description: category.description, icon: category.icon },
        });
    }
    console.log(`  ${CATEGORIES.length} categories`);

    // ── APIs ────────────────────────────────────────────────
    let created = 0;
    for (const api of APIS) {
      // The fingerprint is what makes re-seeding idempotent.
      const fingerprint = `public-apis:${slugify(api.name)}:${api.baseUrl}`;
      const id = schema.deterministicId('api', fingerprint);
      const slug = slugify(api.name);

      await db
        .insert(schema.apis)
        .values({
          id,
          slug,
          name: api.name,
          provider: api.provider,
          description: api.description,
          longDescription: api.longDescription ?? null,
          docsUrl: api.docsUrl,
          baseUrl: api.baseUrl,
          authType: api.authType,
          httpsSupported: api.https,
          corsStatus: api.cors,
          isFree: api.isFree,
          hasFreeTier: api.hasFreeTier,
          status: 'active',
          popularityScore: api.popularity,
          tags: api.tags,
          sourceId,
          sourceRecordId: slug,
          sourceRevision: 'seed',
          fingerprint,
          importedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.apis.fingerprint,
          set: {
            name: api.name,
            description: api.description,
            popularityScore: api.popularity,
            tags: api.tags,
            updatedAt: new Date(),
          },
        });

      const categoryId = categoryIds.get(api.category);
      if (categoryId) {
        await db
          .insert(schema.apiCategories)
          .values({ apiId: id, categoryId, isPrimary: true })
          .onConflictDoNothing();
      }

      // A probe target so the health worker has something to check.
      await db
        .insert(schema.apiEndpoints)
        .values({
          id: schema.deterministicId('endpoint', `${fingerprint}:probe`),
          apiId: id,
          method: 'GET',
          path: api.probePath ?? '/',
          summary: 'Health probe target',
          parameters: [],
          position: 0,
          isProbeTarget: true,
        })
        .onConflictDoNothing();

      await db
        .insert(schema.apiAuthSchemes)
        .values({
          id: schema.deterministicId('authScheme', `${fingerprint}:auth`),
          apiId: id,
          type: api.authType,
          location: api.authType === 'none' ? 'none' : 'header',
          parameterName: api.authType === 'apiKey' ? 'X-API-Key' : null,
          notes:
            api.authType === 'none'
              ? 'No credential required.'
              : `Sign up at ${api.docsUrl} to obtain credentials.`,
          signupUrl: api.authType === 'none' ? null : api.docsUrl,
        })
        .onConflictDoNothing();

      created += 1;
    }
    console.log(`  ${created} APIs`);

    // Refresh denormalised category counts.
    await db.execute(sql`
      UPDATE categories c
         SET api_count = (
           SELECT count(*)
             FROM api_category_map m
             JOIN apis a ON a.id = m.api_id
            WHERE m.category_id = c.id AND a.status = 'active'
         )
    `);

    // ── Demo accounts ───────────────────────────────────────
    const demoPassword = await hashPassword('apihub-demo-password');
    for (const account of [
      { email: 'admin@apihub.dev', name: 'APIHub Admin', role: 'admin' },
      { email: 'demo@apihub.dev', name: 'Demo Developer', role: 'user' },
    ]) {
      await db
        .insert(schema.users)
        .values({
          id: schema.deterministicId('user', account.email),
          email: account.email,
          name: account.name,
          passwordHash: demoPassword,
          role: account.role,
          avatarColor: account.role === 'admin' ? 'hsl(266 70% 58%)' : 'hsl(190 70% 48%)',
        })
        .onConflictDoNothing();
    }
    console.log('  2 demo accounts (password: apihub-demo-password)');

    console.log('\nSeed complete. Start the API with: pnpm dev');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('\nSeed failed:');
  console.error(error);
  process.exit(1);
});
