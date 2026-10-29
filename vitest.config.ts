import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

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
      // Ratchet: set just below the lowest measured level so regressions fail CI; raise as
      // coverage grows toward the 100% goal. Windows measures lower (2026-10-29: 85.7/86.8/93.3)
      // because the cluster and deploy tests are skipped there
      thresholds: {
        lines: 85,
        functions: 92,
        branches: 86,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      // Point at the entry files: an ESM import cannot resolve a bare directory, so unmocked
      // imports of '@opendaemon/core' failed and only worked where a test mocked the module
      '@opendaemon/core': entry('./packages/core/src/index.ts'),
      '@opendaemon/cli': entry('./packages/cli/src/index.ts'),
      '@opendaemon/sdk': entry('./packages/sdk/src/index.ts'),
    },
  },
});
