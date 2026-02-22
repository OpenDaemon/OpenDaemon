import type { EventBus } from '../event-bus.js';
import type { StateStore } from '../state-store.js';
import type { Logger } from '../utils/logger.js';
import type { DaemonConfig, MetricDefinition } from '../types.js';
import type { DaemonError } from '../errors/index.js';

/**
 * RPC handler function type
 */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

/**
 * Hook handler function type
 */
export type HookHandler = (data: unknown) => void | Promise<void>;

/**
 * Plugin lifecycle phase
 */
export type PluginPhase = 'installing' | 'installed' | 'starting' | 'ready' | 'stopping' | 'stopped';

/**
 * Plugin metadata
 */
export interface PluginMetadata {
  /** Unique plugin identifier (kebab-case, e.g., "process-manager") */
  readonly name: string;

  /** Semantic version (e.g., "1.0.0") */
  readonly version: string;

  /** Human-readable description */
  readonly description: string;

  /** Plugin priority (lower = loaded first, default: 100) */
  readonly priority?: number;

  /** Plugin dependencies (other plugin names that must be loaded first) */
  readonly dependencies?: readonly string[];

  /** Plugin conflicts (other plugin names that cannot coexist) */
  readonly conflicts?: readonly string[];

  /** Default configuration for this plugin */
  readonly defaultConfig?: unknown;

  /** JSON Schema for config validation */
  readonly configSchema?: unknown;
}

/**
 * Context object provided to every plugin.
 * This is the plugin's window into the kernel and other plugins.
 *
 * @example
 * ```typescript
 * install(context: PluginContext): void {
 *   // Register RPC method
 *   context.registerMethod('start', this.handleStart.bind(this));
 *
 *   // Listen to events
 *   context.events.on('process:started', (data) => {
 *     context.logger.info('Process started', data);
 *   });
 *
 *   // Access another plugin
 *   const processManager = context.getPlugin<ProcessManagerPlugin>('process-manager');
 * }
 * ```
 */
export interface PluginContext {
  /** Kernel configuration (read-only) */
  readonly config: DaemonConfig;

  /** Plugin's own configuration (read-only) */
  readonly pluginConfig: unknown;

  /** Event bus for pub/sub */
  readonly events: EventBus;

  /** Structured logger scoped to this plugin */
  readonly logger: Logger;

  /** Access to the state store */
  readonly store: StateStore;

  /**
   * Register RPC methods that CLI/SDK can call
   * @param name - Method name (will be prefixed with plugin name)
   * @param handler - Handler function
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMethod(name: string, handler: (...args: any[]) => unknown | Promise<unknown>): void;

  /**
   * Register a hook into another plugin's lifecycle
   * @param hookName - Hook name in format "plugin:hook"
   * @param handler - Handler function
   */
  registerHook(hookName: string, handler: HookHandler): void;

  /**
   * Get a reference to another plugin
   * @param name - Plugin name
   * @returns Plugin instance or undefined if not found
   */
  getPlugin<T extends Plugin>(name: string): T | undefined;

  /**
   * Expose metrics for this plugin
   * @param metric - Metric definition
   */
  registerMetric(metric: MetricDefinition): void;
}

/**
 * Base plugin interface for OpenDaemon.
 * Every feature of OpenDaemon is implemented as a plugin.
 *
 * @example
 * ```typescript
 * class MyPlugin implements Plugin {
 *   name = 'my-plugin';
 *   version = '1.0.0';
 *   description = 'Does something cool';
 *
 *   install(context: PluginContext): void {
 *     context.logger.info('Plugin installed');
 *   }
 *
 *   async onStart(context: PluginContext): Promise<void> {
 *     context.logger.info('Plugin starting');
 *   }
 *
 *   async onReady(context: PluginContext): Promise<void> {
 *     context.logger.info('Plugin ready');
 *   }
 *
 *   async onStop(context: PluginContext): Promise<void> {
 *     context.logger.info('Plugin stopping');
 *   }
 * }
 * ```
 */
export interface Plugin extends PluginMetadata {
  /**
   * Called when the plugin is registered with the kernel.
   * Use this to register event handlers, extend the API, etc.
   *
   * @param context - Plugin context
   */
  install(context: PluginContext): void | Promise<void>;

  /**
   * Called after ALL plugins are installed and daemon is starting.
   * Use this for initialization that depends on other plugins.
   *
   * @param context - Plugin context
   */
  onStart?(context: PluginContext): void | Promise<void>;

  /**
   * Called when daemon is ready to accept commands.
   *
   * @param context - Plugin context
   */
  onReady?(context: PluginContext): void | Promise<void>;

  /**
   * Called during graceful shutdown.
   * Must complete within the configured shutdown timeout.
   *
   * @param context - Plugin context
   */
  onStop?(context: PluginContext): void | Promise<void>;

  /**
   * Called when an error occurs within this plugin's scope.
   *
   * @param error - The error that occurred
   * @param context - Plugin context
   */
  onError?(error: DaemonError, context: PluginContext): void;

  /**
   * Health check for this plugin. Called periodically by watchdog.
   * Return true if healthy, false if unhealthy.
   *
   * @param context - Plugin context
   * @returns True if plugin is healthy
   */
  healthCheck?(context: PluginContext): boolean | Promise<boolean>;
}

/**
 * Registered plugin with metadata
 */
export interface RegisteredPlugin {
  plugin: Plugin;
  phase: PluginPhase;
  error: Error | undefined;
}
