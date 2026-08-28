import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  sourcemap: true,
  clean: true,
  external: ['@electric-sql/pglite', 'pg', '@neondatabase/serverless', 'ioredis', 'bullmq'],
  noExternal: [/^@apihub\//],
});
