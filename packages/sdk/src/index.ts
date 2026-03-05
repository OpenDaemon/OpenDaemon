// SDK client for programmatic access to OpenDaemon

// Re-export core types and utilities
export {
  Kernel,
  EventBus,
  StateMachine,
  StateStore,
  DaemonError,
  ProcessError,
  ConfigError,
  PluginError,
  IpcError,
  ErrorCode,
  assert,
  createError,
  Logger,
  LogLevel,
  PluginRegistry,
  encodeFrame,
  decodeFrames,
  FrameType,
  parseRequest,
  parseResponse,
  createRequest,
  createResponse,
  createErrorResponse,
  serialize,
  JsonRpcErrorCode,
} from '../../core/src/index.js';

// Re-export core types
export type {
  DaemonConfig,
  ProcessConfig,
  ProcessInfo,
  ProcessStatus,
  ProcessMode,
  HealthCheckConfig,
  Plugin,
  PluginContext,
} from '../../core/src/index.js';

// Export SDK-specific modules
export * from './runtime.js';

// ---- Config Helper ----

import type { DaemonConfig } from '../../core/src/index.js';

/**
 * Type-safe config helper for opendaemon.config.ts files.
 *
 * Usage:
 * ```ts
 * import { defineConfig } from '@opendaemon/sdk';
 *
 * export default defineConfig({
 *   apps: [
 *     { name: 'api', script: './dist/server.js', instances: 4, mode: 'cluster' },
 *   ],
 *   plugins: {
 *     webui: { port: 7777 },
 *   },
 * });
 * ```
 */
export function defineConfig(config: DaemonConfig): DaemonConfig {
  return config;
}
