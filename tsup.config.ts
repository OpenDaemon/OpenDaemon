import { defineConfig } from 'tsup';

export default defineConfig([
  // Core package
  {
    entry: ['packages/core/src/index.ts'],
    outDir: 'packages/core/dist',
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true,
    target: 'node20',
  },
  // CLI package
  {
    entry: ['packages/cli/src/index.ts'],
    outDir: 'packages/cli/dist',
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    bundle: true,
    target: 'node20',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // SDK package
  {
    entry: ['packages/sdk/src/index.ts', 'packages/sdk/src/runtime.ts'],
    outDir: 'packages/sdk/dist',
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true,
    target: 'node20',
    external: ['@opendaemon/core'],
  },
]);
