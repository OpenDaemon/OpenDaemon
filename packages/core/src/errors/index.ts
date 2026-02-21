/**
 * Error codes for OpenDaemon
 */
export enum ErrorCode {
  // System errors
  DAEMON_NOT_RUNNING = 'DAEMON_NOT_RUNNING',
  DAEMON_ALREADY_RUNNING = 'DAEMON_ALREADY_RUNNING',
  SOCKET_ERROR = 'SOCKET_ERROR',
  SOCKET_PERMISSION_DENIED = 'SOCKET_PERMISSION_DENIED',

  // Process errors
  PROCESS_NOT_FOUND = 'PROCESS_NOT_FOUND',
  PROCESS_ALREADY_EXISTS = 'PROCESS_ALREADY_EXISTS',
  PROCESS_START_FAILED = 'PROCESS_START_FAILED',
  PROCESS_STOP_FAILED = 'PROCESS_STOP_FAILED',
  PROCESS_INVALID_CONFIG = 'PROCESS_INVALID_CONFIG',

  // Configuration errors
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  CONFIG_INVALID = 'CONFIG_INVALID',
  CONFIG_VALIDATION_ERROR = 'CONFIG_VALIDATION_ERROR',
  CONFIG_PARSE_ERROR = 'CONFIG_PARSE_ERROR',

  // Plugin errors
  PLUGIN_NOT_FOUND = 'PLUGIN_NOT_FOUND',
  PLUGIN_ALREADY_REGISTERED = 'PLUGIN_ALREADY_REGISTERED',
  PLUGIN_DEPENDENCY_MISSING = 'PLUGIN_DEPENDENCY_MISSING',
  PLUGIN_DEPENDENCY_CIRCULAR = 'PLUGIN_DEPENDENCY_CIRCULAR',
  PLUGIN_CONFLICT = 'PLUGIN_CONFLICT',
  PLUGIN_INVALID = 'PLUGIN_INVALID',
  PLUGIN_INITIALIZATION_FAILED = 'PLUGIN_INITIALIZATION_FAILED',

  // Health check errors
  HEALTH_CHECK_FAILED = 'HEALTH_CHECK_FAILED',
  HEALTH_CHECK_TIMEOUT = 'HEALTH_CHECK_TIMEOUT',
  HEALTH_CHECK_INVALID_CONFIG = 'HEALTH_CHECK_INVALID_CONFIG',

  // IPC errors
  IPC_TIMEOUT = 'IPC_TIMEOUT',
  IPC_ERROR = 'IPC_ERROR',
  IPC_CONNECTION_REFUSED = 'IPC_CONNECTION_REFUSED',
  IPC_MESSAGE_TOO_LARGE = 'IPC_MESSAGE_TOO_LARGE',

  // Secret errors
  SECRET_NOT_FOUND = 'SECRET_NOT_FOUND',
  SECRET_DECRYPTION_FAILED = 'SECRET_DECRYPTION_FAILED',
  SECRET_ENCRYPTION_FAILED = 'SECRET_ENCRYPTION_FAILED',

  // Resource errors
  RESOURCE_LIMIT_EXCEEDED = 'RESOURCE_LIMIT_EXCEEDED',
  MEMORY_LIMIT_EXCEEDED = 'MEMORY_LIMIT_EXCEEDED',
  CPU_LIMIT_EXCEEDED = 'CPU_LIMIT_EXCEEDED',

  // General errors
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  TIMEOUT = 'TIMEOUT',
  INVALID_ARGUMENT = 'INVALID_ARGUMENT',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Context information for errors
 */
export interface ErrorContext {
  [key: string]: unknown;
}

/**
 * Base error class for OpenDaemon
 */
export class DaemonError extends Error {
  /**
   * Error code
   */
  readonly code: ErrorCode;

  /**
   * Additional context
   */
  readonly context: ErrorContext | undefined;



  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext | undefined = undefined,
    cause?: Error
  ) {
    super(message, { cause });
    (this as Error).name = 'DaemonError';
    this.code = code;
    this.context = context;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DaemonError);
    }
  }

  /**
   * Convert error to JSON representation
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      stack: this.stack,
      cause: this.cause && typeof this.cause === 'object' && this.cause instanceof Error
        ? {
            name: this.cause.name,
            message: this.cause.message,
          }
        : undefined,
    };
  }
}

/**
 * Error for process-related issues
 */
export class ProcessError extends DaemonError {
  readonly processName: string;

  constructor(
    code: ErrorCode,
    processName: string,
    message: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(code, message, { ...context, processName }, cause);
    this.name = 'ProcessError';
    this.processName = processName;
  }
}

/**
 * Error for configuration issues
 */
export class ConfigError extends DaemonError {
  readonly configPath: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    configPath: string | undefined = undefined,
    context: ErrorContext | undefined = undefined,
    cause: Error | undefined = undefined
  ) {
    super(code, message, { ...context, configPath }, cause);
    this.name = 'ConfigError';
    this.configPath = configPath;
  }
}

/**
 * Error for plugin issues
 */
export class PluginError extends DaemonError {
  readonly pluginName: string;

  constructor(
    code: ErrorCode,
    pluginName: string,
    message: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(code, message, { ...context, pluginName }, cause);
    this.name = 'PluginError';
    this.pluginName = pluginName;
  }
}

/**
 * Error for IPC communication issues
 */
export class IpcError extends DaemonError {
  constructor(
    code: ErrorCode,
    message: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(code, message, context, cause);
    this.name = 'IpcError';
  }
}

/**
 * Assert a condition and throw an error if it fails
 */
export function assert(
  condition: boolean,
  code: ErrorCode,
  message: string,
  context?: ErrorContext
): asserts condition {
  if (!condition) {
    throw new DaemonError(code, message, context);
  }
}

/**
 * Create a typed error from any thrown value
 */
export function createError(
  error: unknown,
  defaultCode: ErrorCode = ErrorCode.UNKNOWN_ERROR
): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  if (error instanceof Error) {
    return new DaemonError(defaultCode, error.message, undefined, error);
  }

  return new DaemonError(defaultCode, String(error));
}
