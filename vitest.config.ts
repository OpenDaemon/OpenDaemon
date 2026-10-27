import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
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
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
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
