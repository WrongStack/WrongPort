import { defineConfig } from 'vitest/config';

// Isolated from vite.config.ts on purpose: the web build sets root: 'web',
// which would make Vitest look for tests in the wrong place.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**', 'web/src/**'],
      // Interface-only type files and CSS carry no runtime statements to cover.
      exclude: ['**/*.d.ts', '**/types.ts', '**/*.css'],
      // The release gate (npm run verify) enforces these — a drop below 100
      // fails the suite, so coverage can only ratchet up.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
