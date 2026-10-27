import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    // tests/e2e drive the built CLI; they run via `npm run test:e2e` after a build
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      // lcov is what the CI codecov upload reads
      reporter: ['text', 'json', 'html', 'lcov'],
      // plugins live one level deeper (packages/plugins/<name>/src) and were silently unmeasured
      include: ['packages/*/src/**/*.ts', 'packages/plugins/*/src/**/*.ts'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types.ts',
      ],
      // Ratchet: set just below the measured level (2026-10-27: 84/88/90/84) so
      // regressions fail CI; raise as coverage grows toward the 100% goal
      thresholds: {
        lines: 82,
        functions: 87,
        branches: 86,
        statements: 82,
      },
    },
  },
  resolve: {
    alias: {
      // Point at the entry files: an ESM import cannot resolve a bare directory, so unmocked
      // imports of '@opendaemon/core' failed and only worked where a test mocked the module
      '@opendaemon/core': './packages/core/src/index.ts',
      '@opendaemon/cli': './packages/cli/src/index.ts',
      '@opendaemon/sdk': './packages/sdk/src/index.ts',
    },
  },
});
