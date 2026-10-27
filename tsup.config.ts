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
    entry: {
      cli: 'packages/cli/src/cli.ts',
      daemon: 'packages/cli/src/daemon.ts',
    },
    outDir: 'packages/cli/dist',
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    bundle: true,
    target: 'node20',
    // No banner: cli.ts and daemon.ts carry their own shebang, which esbuild preserves
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
