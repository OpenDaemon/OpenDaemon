/**
 * Log level enumeration
 */
export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  FATAL = 5,
  SILENT = 6,
}

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  levelName: string;
  namespace: string;
  message: string;
  data: unknown | undefined;
  error: Error | undefined;
}

/**
 * Logger output handler
 */
export type LogHandler = (entry: LogEntry) => void;

/**
 * Structured logger implementation.
 * Supports namespacing, levels, and custom handlers.
 *
 * @example
 * ```typescript
 * const logger = new Logger('my-plugin');
 *
 * logger.info('Server started');
 * logger.warn('High memory usage', { memory: 1024 });
 * logger.error('Connection failed', undefined, error);
 * ```
 */
export class Logger {
  private static globalLevel: LogLevel = LogLevel.INFO;
  private static handlers: LogHandler[] = [Logger.consoleHandler];

  private namespace: string;

  /**
   * Create a new logger with namespace
   *
   * @param namespace - Namespace for this logger (e.g., plugin name)
   */
  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /**
   * Set the global minimum log level
   *
   * @param level - Minimum level to log
   */
  static setGlobalLevel(level: LogLevel): void {
    Logger.globalLevel = level;
  }

  /**
   * Get the current global log level
   *
   * @returns Current global level
   */
  static getGlobalLevel(): LogLevel {
    return Logger.globalLevel;
  }

  /**
   * Add a log handler
   *
   * @param handler - Handler function
   */
  static addHandler(handler: LogHandler): void {
    Logger.handlers.push(handler);
  }

  /**
   * Remove all handlers
   */
  static clearHandlers(): void {
    Logger.handlers = [];
  }

  /**
   * Reset to default console handler
   */
  static resetHandlers(): void {
    Logger.handlers = [Logger.consoleHandler];
  }

  /**
   * Log a trace message
   *
   * @param message - Message to log
   * @param data - Additional data
   */
  trace(message: string, data?: unknown): void {
    this.log(LogLevel.TRACE, message, data);
  }

  /**
   * Log a debug message
   *
   * @param message - Message to log
   * @param data - Additional data
   */
  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * Log an info message
   *
   * @param message - Message to log
   * @param data - Additional data
   */
  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * Log a warning message
   *
   * @param message - Message to log
   * @param data - Additional data
   * @param error - Optional error
   */
  warn(message: string, data?: unknown, error?: Error): void {
    this.log(LogLevel.WARN, message, data, error);
  }

  /**
   * Log an error message
   *
   * @param message - Message to log
   * @param data - Additional data
   * @param error - Optional error
   */
  error(message: string, data?: unknown, error?: Error): void {
    this.log(LogLevel.ERROR, message, data, error);
  }

  /**
   * Log a fatal message
   *
   * @param message - Message to log
   * @param data - Additional data
   * @param error - Optional error
   */
  fatal(message: string, data?: unknown, error?: Error): void {
    this.log(LogLevel.FATAL, message, data, error);
  }

  /**
   * Create a child logger with extended namespace
   *
   * @param subNamespace - Sub-namespace to append
   * @returns New logger instance
   */
  child(subNamespace: string): Logger {
    return new Logger(`${this.namespace}:${subNamespace}`);
  }

  /**
   * Internal log method
   */
  private log(
    level: LogLevel,
    message: string,
    data: unknown = undefined,
    error: Error | undefined = undefined
  ): void {
    if (level < Logger.globalLevel) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      levelName: LogLevel[level],
      namespace: this.namespace,
      message,
      data,
      error,
    };

    for (const handler of Logger.handlers) {
      try {
        handler(entry);
      } catch (err) {
        console.error('Error in log handler:', err);
      }
    }
  }

  /**
   * Default console handler
   */
  private static consoleHandler(entry: LogEntry): void {
    const timestamp = entry.timestamp;
    const level = entry.levelName.padEnd(5);
    const namespace = entry.namespace;
    const message = entry.message;

    let output = `[${timestamp}] [${level}] [${namespace}] ${message}`;

    if (entry.data !== undefined) {
      output += ` ${JSON.stringify(entry.data)}`;
    }

    if (entry.error) {
      output += `\n${entry.error.stack ?? entry.error.message}`;
    }

    // Output to appropriate console method
    switch (entry.level) {
      case LogLevel.TRACE:
      case LogLevel.DEBUG:
        console.debug(output);
        break;
      case LogLevel.INFO:
        console.info(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(output);
        break;
    }
  }
}
