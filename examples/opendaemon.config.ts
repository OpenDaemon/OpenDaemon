// OpenDaemon Configuration Example
// This is a TypeScript configuration file for OpenDaemon

import type { DaemonConfig } from '../packages/core/src/index.js';

const config: DaemonConfig = {
  // Daemon settings
  daemon: {
    pidFile: './opendaemon.pid',
    logDir: './logs',
    shutdownTimeout: 10000,
  },

  // Process definitions
  apps: [
    {
      name: 'api-server',
      script: './examples/simple-server.js',
      cwd: './',
      instances: 2,
      mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
      healthCheck: {
        type: 'http',
        url: 'http://localhost:3000/health',
        interval: 30000,
        timeout: 5000,
        retries: 3,
      },
      maxRestarts: 5,
      minUptime: 10000,
      maxMemory: '512M',
    },
    {
      name: 'worker',
      script: './examples/worker.js',
      instances: 1,
      mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      restartDelay: 5000,
    },
  ],

  // Plugin configuration
  plugins: {
    'process-manager': {
      enabled: true,
    },
    'config-manager': {
      enabled: true,
    },
  },

  // Logging configuration
  logging: {
    level: 'info',
    format: 'json',
    rotation: {
      maxSize: '100M',
      maxFiles: 10,
      compress: true,
    },
  },

  // Watch configuration
  watch: {
    enabled: true,
    paths: ['./examples'],
    ignore: ['node_modules', 'logs'],
    extensions: ['.js', '.ts'],
  },
};

export default config;