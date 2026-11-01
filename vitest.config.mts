import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CI machines usually run in UTC, where timezone bugs stay hidden. Run in Paris, like production.
    env: { TZ: 'Europe/Paris' },
  },
});
