import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    // Production runs in Paris; date logic must not depend on the machine's timezone.
    env: { TZ: 'Europe/Paris' },
  },
});
