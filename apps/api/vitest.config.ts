import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Integration tests share one embedded PostgreSQL; run files serially.
    fileParallelism: false,
  },
});
