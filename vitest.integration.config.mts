import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Never reset the developer's database: integration tests get their own.
    env: { TZ: 'Europe/Paris', PGDATABASE: 'matching_test' },
  },
});
