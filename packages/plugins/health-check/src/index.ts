import type {
  Plugin,
  PluginContext,
  HealthCheckConfig,
  HealthCheckAction,
  ProcessConfig,
  ProcessInfo,
} from '../../../core/src/index.js';
import { runCheck, validateHealthCheck, type CheckResult } from './checks.js';

export { parseBytes, runCheck, validateHealthCheck } from './checks.js';

/**
 * The part of the process-manager plugin this plugin relies on
 */
interface ProcessManagerApi {
  getProcesses(): ProcessInfo[];
  getProcessConfig(name: string): ProcessConfig | undefined;
  restartProcessFromPlugin(name: string): Promise<unknown>;
  stopProcessFromPlugin(name: string): Promise<void>;
}

type HealthStatus = 'unknown' | 'healthy' | 'unhealthy';

interface Monitor {
  name: string;
  config: HealthCheckConfig;
  interval: number;
  timeout: number;
  failureThreshold: number;
  successThreshold: number;
  action: HealthCheckAction;
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastResult?: CheckResult & { at: string };
  timer?: NodeJS.Timeout;
}

/**
 * Health status of one process, as returned by the `health` RPC method
 */
export interface HealthReport {
  name: string;
  type: string;
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastResult?: CheckResult & { at: string };
}

/**
 * Health Check Plugin
 * Runs each process's `healthCheck` on a schedule and restarts/stops it when it turns unhealthy.
 */
export class HealthCheckPlugin implements Plugin {
  name = 'health-check';
  version = '1.0.0';
  description = 'Periodic process health checks with automatic recovery';
  priority = 15;
  dependencies = ['process-manager'];

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private readonly monitors = new Map<string, Monitor>();
  private stopped = false;

  install(context: PluginContext): void {
    this.context = context;

    // Subscribed at install time: process-manager starts configured apps during its own
    // onStart, which runs before ours
    context.events.on('process:started', (data: unknown) => {
      this.watch((data as { name: string }).name);
    });
    context.events.on('process:stopped', (data: unknown) => {
      this.unwatch((data as { name: string }).name);
    });

    context.registerMethod('health', (params: unknown) => {
      const name = (params as { name?: string } | undefined)?.name;
      return Promise.resolve(this.getReports(name));
    });
  }

  onStart(): void {
    this.stopped = false;
    for (const proc of this.processManager()?.getProcesses() ?? []) {
      if (proc.status === 'online' && !this.monitors.has(proc.name)) {
        this.watch(proc.name);
      }
    }
  }

  onStop(): void {
    this.stopped = true;
    for (const name of [...this.monitors.keys()]) {
      this.unwatch(name);
    }
  }

  /**
   * Current health of all monitored processes, or of one by name
   */
  getReports(name?: string): HealthReport[] {
    return [...this.monitors.values()]
      .filter((m) => name === undefined || m.name === name)
      .map((m) => ({
        name: m.name,
        type: m.config.type,
        status: m.status,
        consecutiveFailures: m.consecutiveFailures,
        consecutiveSuccesses: m.consecutiveSuccesses,
        ...(m.lastResult ? { lastResult: m.lastResult } : {}),
      }));
  }

  private processManager(): ProcessManagerApi | undefined {
    return this.context.getPlugin('process-manager') as unknown as ProcessManagerApi | undefined;
  }

  private watch(name: string): void {
    const config = this.processManager()?.getProcessConfig(name)?.healthCheck;
    this.unwatch(name);
    if (!config || this.stopped) {
      return;
    }

    const problems = validateHealthCheck(config);
    if (problems.length > 0) {
      this.context.logger.error(`Health check for "${name}" disabled: ${problems.join('; ')}`);
      return;
    }

    const monitor: Monitor = {
      name,
      config,
      interval: config.interval ?? 30000,
      timeout: config.timeout ?? 5000,
      failureThreshold: config.failureThreshold ?? 3,
      successThreshold: config.successThreshold ?? 1,
      action: config.action ?? 'restart',
      status: 'unknown',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };
    this.monitors.set(name, monitor);
    this.schedule(monitor, config.initialDelay ?? 0);
  }

  private unwatch(name: string): void {
    const monitor = this.monitors.get(name);
    if (monitor) {
      clearTimeout(monitor.timer);
      this.monitors.delete(name);
    }
  }

  /**
   * Chained timeouts rather than setInterval, so a slow check never overlaps the next one
   */
  private schedule(monitor: Monitor, delay: number): void {
    monitor.timer = setTimeout(() => {
      void this.tick(monitor).finally(() => {
        // The monitor may have been replaced (restart) or removed (stop) while checking
        if (this.monitors.get(monitor.name) === monitor) {
          this.schedule(monitor, monitor.interval);
        }
      });
    }, delay);
    monitor.timer.unref();
  }

  private async tick(monitor: Monitor): Promise<void> {
    const proc = this.processManager()?.getProcesses().find((p) => p.name === monitor.name);
    // Skip while the process is (re)starting or stopped; those states are not health signals
    if (proc?.status !== 'online') {
      return;
    }

    const events = this.context.events;
    events.emit('health:check:start', { name: monitor.name, type: monitor.config.type });

    let result: CheckResult;
    try {
      result = await runCheck(monitor.config, { name: proc.name, pids: proc.pids, cpu: proc.cpu, memory: proc.memory }, monitor.timeout);
    } catch (err) {
      result = { ok: false, message: (err as Error).message };
    }

    if (this.monitors.get(monitor.name) !== monitor) {
      return;
    }
    monitor.lastResult = { ...result, at: new Date().toISOString() };
    events.emit(result.ok ? 'health:check:pass' : 'health:check:fail', { name: monitor.name, ...result });

    if (result.ok) {
      monitor.consecutiveSuccesses++;
      monitor.consecutiveFailures = 0;
      if (monitor.status !== 'healthy' && monitor.consecutiveSuccesses >= monitor.successThreshold) {
        monitor.status = 'healthy';
        events.emit('health:status:healthy', { name: monitor.name });
      }
      return;
    }

    monitor.consecutiveFailures++;
    monitor.consecutiveSuccesses = 0;
    if (monitor.status !== 'unhealthy' && monitor.consecutiveFailures >= monitor.failureThreshold) {
      monitor.status = 'unhealthy';
      this.context.logger.warn(`Process "${monitor.name}" is unhealthy: ${result.message}`);
      events.emit('health:status:unhealthy', { name: monitor.name, message: result.message });
      await this.act(monitor);
    }
  }

  private async act(monitor: Monitor): Promise<void> {
    const pm = this.processManager();
    if (!pm) return;

    try {
      if (monitor.action === 'restart') {
        this.context.events.emit('health:action:restart', { name: monitor.name });
        // Restart emits process:stopped/started, which replaces this monitor with a fresh one
        await pm.restartProcessFromPlugin(monitor.name);
      } else if (monitor.action === 'stop') {
        this.context.events.emit('health:action:stop', { name: monitor.name });
        await pm.stopProcessFromPlugin(monitor.name);
      }
      // 'notify' and 'none' only report: health:status:unhealthy has already been emitted
    } catch (err) {
      this.context.logger.error(`Health action "${monitor.action}" failed for "${monitor.name}"`, undefined, err as Error);
    }
  }
}
