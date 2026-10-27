import { defineConfig } from 'vitest/config';

// End-to-end suite: spawns the built `od` CLI and a real daemon, so it runs after `npm run build`
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Suites share the daemon's fixed Windows TCP port, so run files one at a time
    fileParallelism: false,
  },
});
