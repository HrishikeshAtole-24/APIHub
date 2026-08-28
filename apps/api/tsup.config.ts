import { defineConfig } from 'tsup';

/**
 * Bundle the API and its workspace dependencies into a single ESM output.
 * Bundling the internal @apihub/* packages means the deployed artifact does not
 * need the monorepo layout, which keeps the Docker image small and simple.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Native/optional dependencies stay external; they are resolved at runtime.
  external: ['@electric-sql/pglite', 'pg', '@neondatabase/serverless', 'ioredis', 'bullmq'],
  noExternal: [/^@apihub\//],
});
