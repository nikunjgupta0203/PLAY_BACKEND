import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Testcontainers pulls a real Postgres; the first run is slow.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // DB-backed suites share one container and truncate between tests,
    // so they must not run concurrently against each other.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
