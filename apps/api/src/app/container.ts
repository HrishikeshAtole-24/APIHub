/**
 * Composition root.
 *
 * Every dependency is constructed once, here, and injected downward. Nothing
 * below this file reaches for a global: services receive their database,
 * cache and collaborators as constructor arguments, which is what makes them
 * testable without a running server (report 28).
 */
import { getCache, type CacheService } from '@apihub/runtime';
import { getDatabase, type Database, type DatabaseHandle } from '@apihub/database';

import { AuthService } from '../modules/auth/service.js';
import { CatalogRepository } from '../modules/catalog/repository.js';
import { CatalogService } from '../modules/catalog/service.js';
import { CollectionService } from '../modules/users/collection-service.js';
import { FavoriteService } from '../modules/users/favorite-service.js';
import { HealthRepository } from '../modules/health/repository.js';
import { HealthService } from '../modules/health/service.js';
import { PlaygroundService } from '../modules/playground/service.js';
import { RecommendationService } from '../modules/recommendations/service.js';
import { ReviewService } from '../modules/reviews/service.js';
import { SearchRepository } from '../modules/search/repository.js';
import { SearchService } from '../modules/search/service.js';
import { AdminService } from '../modules/admin/service.js';

export interface Container {
  handle: DatabaseHandle;
  db: Database;
  cache: CacheService;

  auth: AuthService;
  catalog: CatalogService;
  search: SearchService;
  health: HealthService;
  playground: PlaygroundService;
  reviews: ReviewService;
  favorites: FavoriteService;
  collections: CollectionService;
  recommendations: RecommendationService;
  admin: AdminService;
}

export async function buildContainer(overrides?: {
  handle?: DatabaseHandle;
  cache?: CacheService;
}): Promise<Container> {
  const handle = overrides?.handle ?? (await getDatabase());
  const cache = overrides?.cache ?? (await getCache());
  const db = handle.db;

  const catalogRepository = new CatalogRepository(db);
  const searchRepository = new SearchRepository(db);
  const healthRepository = new HealthRepository(db);

  const catalog = new CatalogService(catalogRepository, cache);
  const search = new SearchService(searchRepository, catalogRepository, cache);
  const health = new HealthService(healthRepository, cache);
  const reviews = new ReviewService(db, cache);
  const favorites = new FavoriteService(db, catalogRepository);
  const collections = new CollectionService(db, catalogRepository);
  const recommendations = new RecommendationService(searchRepository, catalogRepository);
  const playground = new PlaygroundService(db);
  const admin = new AdminService(db, cache, handle);

  return {
    handle,
    db,
    cache,
    auth: new AuthService(db),
    catalog,
    search,
    health,
    playground,
    reviews,
    favorites,
    collections,
    recommendations,
    admin,
  };
}
