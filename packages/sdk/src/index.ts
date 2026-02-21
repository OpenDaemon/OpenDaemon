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

// Export SDK-specific modules
export * from './runtime.js';
