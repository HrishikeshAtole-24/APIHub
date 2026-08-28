/**
 * Route registration (report 12.1, 32).
 *
 * Every public route lives under /v1 so the contract can be versioned
 * independently of the implementation.
 */
import type { FastifyInstance } from 'fastify';

import type { Container } from '../app/container.js';
import { registerAdminRoutes } from './admin.js';
import { registerAuthRoutes } from './auth.js';
import { registerCatalogRoutes } from './catalog.js';
import { registerHealthRoutes } from './health.js';
import { registerMeRoutes } from './me.js';
import { registerPlaygroundRoutes } from './playground.js';
import { registerReviewRoutes } from './reviews.js';
import { registerSearchRoutes } from './search.js';
import { registerSystemRoutes } from './system.js';

export async function registerRoutes(app: FastifyInstance, container: Container): Promise<void> {
  // Unversioned operational endpoints; orchestrators expect stable paths.
  await registerSystemRoutes(app, container);

  await app.register(
    async (v1) => {
      await registerCatalogRoutes(v1, container);
      await registerSearchRoutes(v1, container);
      await registerHealthRoutes(v1, container);
      await registerPlaygroundRoutes(v1, container);
      await registerAuthRoutes(v1, container);
      await registerMeRoutes(v1, container);
      await registerReviewRoutes(v1, container);
      await registerAdminRoutes(v1, container);
    },
    { prefix: '/v1' },
  );
}
