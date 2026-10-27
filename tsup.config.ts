import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

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
      // Spawned by the process manager in cluster mode; found next to daemon.js at runtime
      'cluster-primary': 'packages/plugins/process-manager/src/cluster-primary.mjs',
    },
    outDir: 'packages/cli/dist',
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    bundle: true,
    target: 'node20',
    // No banner: cli.ts and daemon.ts carry their own shebang, which esbuild preserves
    define: {
      __OPENDAEMON_VERSION__: JSON.stringify(version),
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
