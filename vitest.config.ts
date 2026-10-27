import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist'],
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
      '@opendaemon/core': './packages/core/src',
      '@opendaemon/cli': './packages/cli/src',
      '@opendaemon/sdk': './packages/sdk/src',
    },
  },
});
