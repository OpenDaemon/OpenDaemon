import { EventBus } from './event-bus.js';
import { StateMachine } from './state-machine.js';
import { StateStore } from './state-store.js';
import { Logger } from './utils/logger.js';
import { PluginRegistry } from './plugins/registry.js';
import type { Plugin, PluginContext } from './plugins/types.js';
import type { DaemonConfig } from './types.js';
import {
  DaemonError,
  ErrorCode,
  PluginError,
} from './errors/index.js';

/**
 * Daemon states
 */
type DaemonState =
  | 'created'
  | 'starting'
  | 'started'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error';

/**
 * Daemon state events
 */
type DaemonEvent =
  | 'start'
  | 'pluginsInstalled'
  | 'pluginsStarted'
  | 'ready'
  | 'stop'
  | 'stopped'
  | 'error';

/**
 * Micro-kernel for OpenDaemon.
 * Manages plugins, state, and lifecycle.
 *
 * @example
 * ```typescript
 * const kernel = new Kernel();
 *
 * // Register plugins
 * kernel.registerPlugin(new ProcessManagerPlugin());
 *
 * // Start daemon
 * await kernel.start(config);
 *
 * // Stop daemon
 * await kernel.stop();
 * ```
 */
export class Kernel {
  private config: DaemonConfig = {};
  private stateMachine: StateMachine<DaemonState, DaemonEvent>;
  private registry: PluginRegistry;
  private events: EventBus;
  private store: StateStore;
  private logger: Logger;
  private watchdog: NodeJS.Timeout | undefined;
  private readonly watchdogInterval = 30000; // 30 seconds

  /**
   * Create a new kernel instance
   */
  constructor() {
    this.registry = new PluginRegistry();
    this.events = new EventBus();
    this.store = new StateStore();
    this.logger = new Logger('kernel');

    // Initialize state machine
    this.stateMachine = new StateMachine<DaemonState, DaemonEvent>({
      initial: 'created',
      transitions: [
        { from: 'created', event: 'start', to: 'starting' },
        { from: 'starting', event: 'pluginsInstalled', to: 'started' },
        { from: 'started', event: 'pluginsStarted', to: 'ready' },
        { from: 'ready', event: 'stop', to: 'stopping' },
        { from: 'stopping', event: 'stopped', to: 'stopped' },
        { from: 'created', event: 'error', to: 'error' },
        { from: 'starting', event: 'error', to: 'error' },
        { from: 'started', event: 'error', to: 'error' },
        { from: 'ready', event: 'error', to: 'error' },
        { from: 'stopping', event: 'error', to: 'error' },
      ],
    });

    // Add state transition hooks
    this.stateMachine.afterTransition((_from, to) => {
      this.logger.debug(`State transition to: ${to}`);
      this.store.set('daemon.state', to);
      this.events.emit('daemon:state', { state: to });
    });
  }

  /**
   * Get current daemon state
   */
  getState(): DaemonState {
    return this.stateMachine.getState();
  }

  /**
   * Check if daemon is running
   */
  isRunning(): boolean {
    const state = this.getState();
    return state === 'ready' || state === 'started' || state === 'starting';
  }

  /**
   * Register a plugin
   *
   * @param plugin - Plugin to register
   */
  registerPlugin(plugin: Plugin): void {
    if (this.isRunning()) {
      throw new DaemonError(
        ErrorCode.DAEMON_ALREADY_RUNNING,
        'Cannot register plugins while daemon is running'
      );
    }

    this.registry.register(plugin);
    this.logger.debug(`Plugin registered: ${plugin.name}`);
  }

  /**
   * Get a registered plugin
   *
   * @param name - Plugin name
   * @returns Plugin instance or undefined
   */
  getPlugin<T extends Plugin>(name: string): T | undefined {
    return this.registry.getPlugin<T>(name);
  }

  /**
   * Start the daemon
   *
   * @param config - Daemon configuration
   */
  async start(config: DaemonConfig = {}): Promise<void> {
    if (this.isRunning()) {
      throw new DaemonError(
        ErrorCode.DAEMON_ALREADY_RUNNING,
        'Daemon is already running'
      );
    }

    try {
      this.config = config;
      this.store.set('daemon.config', config);
      this.store.set('daemon.startedAt', new Date().toISOString());

      // Transition to starting
      await this.stateMachine.transition('start');
      this.logger.info('Daemon starting...');

      // Install plugins
      await this.installPlugins();
      await this.stateMachine.transition('pluginsInstalled');

      // Start plugins
      await this.startPlugins();
      await this.stateMachine.transition('pluginsStarted');
      await this.stateMachine.transition('ready');

      // Start watchdog
      this.startWatchdog();

      this.logger.info('Daemon ready');
      this.events.emit('daemon:ready');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Failed to start daemon', undefined, error);
      await this.stateMachine.transition('error');
      throw err;
    }
  }

  /**
   * Stop the daemon gracefully
   */
  async stop(): Promise<void> {
    const state = this.getState();
    if (state === 'stopped' || state === 'created') {
      return;
    }

    this.logger.info('Daemon stopping...');

    // Stop watchdog
    this.stopWatchdog();

    // Transition to stopping
    await this.stateMachine.transition('stop');

    // Stop plugins in reverse order
    const plugins = this.registry.resolveLoadOrder().reverse();

    for (const plugin of plugins) {
      try {
        this.registry.setPhase(plugin.name, 'stopping');

        if (plugin.onStop) {
          const timeout = this.config.daemon?.shutdownTimeout ?? 10000;
          await this.withTimeout(
            plugin.onStop(this.createPluginContext(plugin)),
            timeout,
            `Plugin "${plugin.name}" onStop timeout`
          );
        }

        this.registry.setPhase(plugin.name, 'stopped');
        this.logger.debug(`Plugin stopped: ${plugin.name}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `Failed to stop plugin: ${plugin.name}`,
          undefined,
          error
        );
      }
    }

    await this.stateMachine.transition('stopped');
    this.logger.info('Daemon stopped');
    this.events.emit('daemon:stopped');
  }

  /**
   * Get event bus
   */
  getEvents(): EventBus {
    return this.events;
  }

  /**
   * Get state store
   */
  getStore(): StateStore {
    return this.store;
  }

  /**
   * Get configuration
   */
  getConfig(): DaemonConfig {
    return this.config;
  }

  /**
   * Install all registered plugins
   */
  private async installPlugins(): Promise<void> {
    const plugins = this.registry.resolveLoadOrder();

    for (const plugin of plugins) {
      try {
        const context = this.createPluginContext(plugin);
        await plugin.install(context);
        this.registry.setPhase(plugin.name, 'installed');
        this.logger.debug(`Plugin installed: ${plugin.name}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `Failed to install plugin: ${plugin.name}`,
          undefined,
          error
        );
        throw new PluginError(
          ErrorCode.PLUGIN_INITIALIZATION_FAILED,
          plugin.name,
          `Failed to install plugin: ${error.message}`,
          undefined,
          error
        );
      }
    }
  }

  /**
   * Start all installed plugins
   */
  private async startPlugins(): Promise<void> {
    const plugins = this.registry.resolveLoadOrder();

    for (const plugin of plugins) {
      try {
        const context = this.createPluginContext(plugin);

        if (plugin.onStart) {
          await plugin.onStart(context);
        }

        this.registry.setPhase(plugin.name, 'starting');
        this.logger.debug(`Plugin started: ${plugin.name}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `Failed to start plugin: ${plugin.name}`,
          undefined,
          error
        );
        throw new PluginError(
          ErrorCode.PLUGIN_INITIALIZATION_FAILED,
          plugin.name,
          `Failed to start plugin: ${error.message}`,
          undefined,
          error
        );
      }
    }

    // Call onReady for all plugins
    for (const plugin of plugins) {
      try {
        const context = this.createPluginContext(plugin);

        if (plugin.onReady) {
          await plugin.onReady(context);
        }

        this.registry.setPhase(plugin.name, 'ready');
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `Plugin onReady failed: ${plugin.name}`,
          undefined,
          error
        );
      }
    }
  }

  /**
   * Create a plugin context
   */
  private createPluginContext(plugin: Plugin): PluginContext {
    const pluginLogger = new Logger(plugin.name);

    return {
      config: this.config,
      pluginConfig: this.config.plugins?.[plugin.name],
      events: this.events,
      logger: pluginLogger,
      store: this.store,

      registerMethod: (_name: string, _handler: unknown): void => {
        // Will be implemented when IPC is added
        this.logger.warn('RPC methods not yet implemented');
      },

      registerHook: (_hookName: string, _handler: unknown): void => {
        // Will be implemented when hooks system is added
        this.logger.warn('Hooks not yet implemented');
      },

      getPlugin: <T extends Plugin>(name: string): T | undefined => {
        return this.registry.getPlugin<T>(name);
      },

      registerMetric: (_metric: unknown): void => {
        // Will be implemented when metrics system is added
        this.logger.warn('Metrics not yet implemented');
      },
    };
  }

  /**
   * Start the watchdog timer
   */
  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      this.runHealthChecks();
    }, this.watchdogInterval);
  }

  /**
   * Stop the watchdog timer
   */
  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /**
   * Run health checks on all plugins
   */
  private async runHealthChecks(): Promise<void> {
    const plugins = this.registry.getAll();

    for (const registered of plugins) {
      if (registered.plugin.healthCheck && registered.phase === 'ready') {
        try {
          const context = this.createPluginContext(registered.plugin);
          const healthy = await registered.plugin.healthCheck(context);

          if (!healthy) {
            this.logger.warn(`Plugin health check failed: ${registered.plugin.name}`);
            this.events.emit('plugin:unhealthy', {
              plugin: registered.plugin.name,
            });

            if (registered.plugin.onError) {
              const error = new DaemonError(
                ErrorCode.HEALTH_CHECK_FAILED,
                `Health check failed for plugin: ${registered.plugin.name}`
              );
              registered.plugin.onError(error, context);
            }
          }
        } catch (err) {
          this.logger.error(
            `Health check error for plugin: ${registered.plugin.name}`,
            undefined,
            err instanceof Error ? err : new Error(String(err))
          );
        }
      }
    }
  }

  /**
   * Execute a promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T> | void,
    timeoutMs: number,
    message: string
  ): Promise<T | void> {
    if (!promise) {
      return;
    }

    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new DaemonError(ErrorCode.TIMEOUT, message));
        }, timeoutMs);
      }),
    ]);
  }
}
