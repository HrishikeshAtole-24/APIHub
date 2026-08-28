import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // PGlite boots a WASM PostgreSQL; give integration tests room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
