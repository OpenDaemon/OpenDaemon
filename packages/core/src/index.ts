// Core exports
export { Kernel } from './kernel.js';

// Event system
export { EventBus, type EventHandler, type Unsubscribe } from './event-bus.js';

// State management
export {
  StateMachine,
  type StateMachineConfig,
  type TransitionHook,
} from './state-machine.js';
export { StateStore, type StateSubscriber } from './state-store.js';

// Error handling
export {
  DaemonError,
  ProcessError,
  ConfigError,
  PluginError,
  IpcError,
  ErrorCode,
  type ErrorContext,
  assert,
  createError,
} from './errors/index.js';

// Plugin system
export {
  PluginRegistry,
  type Plugin,
  type PluginContext,
  type PluginMetadata,
  type RpcHandler,
  type HookHandler,
  type PluginPhase,
  type RegisteredPlugin,
} from './plugins/index.js';

// Types
export type {
  HealthCheckAction,
  HealthCheckType,
  HealthCheckConfig,
  ProcessConfig,
  ProcessStatus,
  ProcessInfo,
  DaemonConfig,
  LogRotationConfig,
  WatchConfig,
  MetricType,
  MetricDefinition,
  MetricValue,
  ProcessMetrics,
  SystemMetrics,
} from './types.js';

// Utilities
export { Logger, LogLevel, type LogEntry, type LogHandler } from './utils/logger.js';

// IPC
export { encodeFrame, decodeFrames, FrameType, type Frame } from './ipc/protocol.js';
export {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  JsonRpcErrorCode,
  parseRequest,
  parseResponse,
  createRequest,
  createResponse,
  createErrorResponse,
  serialize,
} from './ipc/rpc.js';
