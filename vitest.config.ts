import { defineConfig } from 'vitest/config';

// Isolated from vite.config.ts on purpose: the web build sets root: 'web',
// which would make Vitest look for tests in the wrong place.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
