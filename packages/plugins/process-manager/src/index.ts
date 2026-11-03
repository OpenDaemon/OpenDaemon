import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { resolveLaunch, killTree, groupAlive } from './launch.js';
import { ChildRegistry } from './orphans.js';
import { Logger, parseBytes, dependencyLevels, parseCron, nextRun, assertTimeZone } from '../../../core/src/index.js';
import type { CountLimit, LimitAction, Release } from '../../../core/src/index.js';
import { DaemonError, ErrorCode, ProcessError } from '../../../core/src/index.js';
import type {
  ProcessConfig,
  ProcessInfo,
  ProcessStatus,
  ProcessLogEntry,
  MetricSnapshot,
} from '../../../core/src/index.js';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { availableParallelism, constants as osConstants } from 'os';
import { fileURLToPath } from 'url';

/**
 * The `metrics` of an { type: 'od:metrics' } IPC message from the SDK runtime, if it is one
 */
function metricsFrom(message: unknown): MetricSnapshot[] | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const msg = message as { type?: unknown; metrics?: unknown };
  return msg.type === 'od:metrics' && Array.isArray(msg.metrics) ? (msg.metrics as MetricSnapshot[]) : undefined;
}

/**
 * cluster-primary: bundled next to the daemon as cluster-primary.js; from source it is the .mjs
 */
function clusterPrimaryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, 'cluster-primary.js');
  return existsSync(bundled) ? bundled : resolve(here, 'cluster-primary.mjs');
}

/**
 * Managed process information
 */
interface LogEntry {
  timestamp: string;
  level: 'stdout' | 'stderr';
  message: string;
}

type LimitKind = 'memory' | 'cpu' | 'fds' | 'children' | 'eventLoop';

interface ManagedProcessInfo {
  id: number;
  config: ProcessConfig;
  status: ProcessStatus;
  pid?: number | undefined;
  pids: number[];
  startTime?: Date;
  restartCount: number;
  /** Crashes in a row without a stable run in between: what maxRestarts and the backoff count */
  failStreak: number;
  lastRestart?: Date;
  childProcess?: ChildProcess | undefined;
  /** Cluster mode: worker index -> pid, as reported by the cluster primary */
  workerPids: Map<number, number>;
  /** Cluster mode: deploy steps waiting for the primary's answer, by id */
  deployWaiters?: Map<string, (message: { ok: boolean; error?: string; pid?: number }) => void> | undefined;
  /** Latest SDK runtime metrics per instance ('' in fork mode, the worker index in cluster mode) */
  customMetrics: Map<string, MetricSnapshot[]>;
  stopTimeout?: NodeJS.Timeout | undefined;
  cpu: number;
  memory: number;
  /** Open file descriptors and descendant processes; only measured when a limit asks for them */
  fds?: number;
  children?: number;
  metricsInterval?: NodeJS.Timeout | undefined;
  /** Pending restart from `cronRestart` */
  cronRestartTimer?: NodeJS.Timeout | undefined;
  cpuSamples?: Map<number, { ticks: number; at: number }> | undefined;
  /** When each exceeded limit started being exceeded, and whether its action already ran */
  limitState?: Partial<Record<LimitKind, { since: number; acted: boolean } | undefined>>;
  /** Why the process is waiting or errored without having run (shown in od info) */
  statusReason?: string | undefined;
  logs: LogEntry[];
}

/**
 * Process Manager Plugin
 * Manages the lifecycle of processes
 */
export class ProcessManagerPlugin implements Plugin {
  name = 'process-manager';
  version = '1.0.0';
  description = 'Manages process lifecycle';
  priority = 10;

  private readonly processes = new Map<string, ManagedProcessInfo>();
  private nextId = 0;
  private context!: PluginContext;
  private readonly logger: Logger;
  private stopping = false;
  /** Saved apps that were stopped when saved: listed, not started */
  private savedStopped = new Set<string>();
  /** Dependency levels of the configured apps (level 0 has no dependencies) */
  private startLevels: string[][] = [];

  /** Where `save` writes the process list (dump.json in the daemon's home); unset: no persistence */
  private readonly dumpFile: string | undefined;

  /** Children of this daemon, so the next one can stop what this one leaves behind if it is killed */
  private readonly registry: ChildRegistry | undefined;

  constructor(home?: string) {
    this.logger = new Logger('process-manager');
    this.dumpFile = home === undefined ? undefined : resolve(home, 'dump.json');
    this.registry = home === undefined ? undefined : new ChildRegistry(resolve(home, 'children.json'));
  }

  /**
   * Apps saved by `od save` that the config does not define itself. A saved list that cannot be
   * read is ignored with a warning: it must never keep the daemon from starting.
   */
  private readDump(configured: ProcessConfig[]): Array<{ config: ProcessConfig; stopped: boolean }> {
    if (this.dumpFile === undefined || !existsSync(this.dumpFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.dumpFile, 'utf-8')) as { processes?: unknown };
      if (!Array.isArray(parsed.processes)) throw new Error('"processes" is not a list');
      const known = new Set(configured.map((app) => app.name));
      const saved: Array<{ config: ProcessConfig; stopped: boolean }> = [];
      for (const entry of parsed.processes as Array<{ config?: ProcessConfig; stopped?: boolean }>) {
        const config = entry.config;
        if (typeof config?.name !== 'string' || typeof config.script !== 'string' || known.has(config.name)) continue;
        known.add(config.name);
        saved.push({ config, stopped: entry.stopped === true });
      }
      return saved;
    } catch (err) {
      this.logger.warn(`Ignoring ${this.dumpFile}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Write the process list to dump.json (like `pm2 save`), so the daemon brings it back after a
   * reboot. The file is private to the user because it holds the apps' environment.
   */
  private saveProcesses(): Promise<{ file: string; saved: string[] }> {
    if (this.dumpFile === undefined) {
      return Promise.reject(new DaemonError(ErrorCode.CONFIG_INVALID, 'Saving is not available: the plugin has no home directory'));
    }
    const entries = [...this.processes.values()]
      .map((proc) => ({ config: proc.config, stopped: proc.status !== 'online' && proc.status !== 'starting' }));
    const temp = `${this.dumpFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), processes: entries }, null, 2), { mode: 0o600 });
    renameSync(temp, this.dumpFile);
    this.logger.info(`Saved ${entries.length} process(es) to ${this.dumpFile}`);
    return Promise.resolve({ file: this.dumpFile, saved: entries.map((e) => e.config.name) });
  }

  /**
   * Start what `od save` stored and is not running yet (like `pm2 resurrect`)
   */
  private async resurrectProcesses(): Promise<{ started: string[]; skipped: string[]; failed: string[] }> {
    const result = { started: [] as string[], skipped: [] as string[], failed: [] as string[] };
    // What is already running is left alone; stopped and errored apps are started again
    const running = [...this.processes.values()]
      .filter((proc) => proc.status !== 'stopped' && proc.status !== 'errored')
      .map((proc) => proc.config);
    for (const { config, stopped } of this.readDump(running)) {
      if (stopped) {
        this.processes.set(config.name, this.placeholder(config, 'stopped', 'saved as stopped'));
        result.skipped.push(config.name);
        continue;
      }
      try {
        await this.startFromRpc(config);
        result.started.push(config.name);
      } catch {
        result.failed.push(config.name);
      }
    }
    return result;
  }

  /**
   * Install the plugin
   */
  install(context: PluginContext): void {
    this.context = context;
    this.logger.info('Process manager installed');

    // Register RPC methods
    context.registerMethod('list', this.listProcesses.bind(this));
    context.registerMethod('start', this.startFromRpc.bind(this));
    context.registerMethod('stop', this.stopProcess.bind(this));
    context.registerMethod('restart', this.restartProcess.bind(this));
    context.registerMethod('delete', this.deleteProcess.bind(this));
    context.registerMethod('info', this.getProcessInfo.bind(this));
    context.registerMethod('logs', this.getProcessLogs.bind(this));
    context.registerMethod('scale', this.scaleProcess.bind(this));
    context.registerMethod('save', this.saveProcesses.bind(this));
    context.registerMethod('resurrect', this.resurrectProcesses.bind(this));
    context.registerMethod('reset', this.resetProcess.bind(this));
    context.registerMethod('signal', this.signalProcess.bind(this));
    context.registerMethod('env', this.processEnv.bind(this));
  }

  /**
   * Start the plugin
   */
  async onStart(context: PluginContext): Promise<void> {
    this.logger.info('Process manager starting');

    // Load processes from config. Independent apps start in parallel and are awaited; an app
    // with `dependencies` starts once they are ready, in the background, so the daemon (and its
    // IPC) comes up without waiting for health checks.
    // Processes a daemon that was killed left running would clash with the ones started now
    const orphans = await this.registry?.reap() ?? [];
    if (orphans.length > 0) this.logger.warn(`Stopped ${String(orphans.length)} process(es) left behind by a previous daemon: ${orphans.join(', ')}`);

    const configured = context.config.apps ?? [];
    // Apps saved with `od save` come back too (unless daemon.resurrect is false); when the saved
    // list does not fit the config (a dependency that no longer exists), only the config starts
    const saved = context.config.daemon?.resurrect === false ? [] : this.readDump(configured);
    this.savedStopped = new Set(saved.filter((entry) => entry.stopped).map((entry) => entry.config.name));
    let apps = [...configured, ...saved.map((entry) => entry.config)];
    let levels: string[][];
    try {
      levels = dependencyLevels(apps);
    } catch (err) {
      if (saved.length === 0) {
        this.logger.error(`Not starting apps: ${(err as Error).message}`);
        return;
      }
      this.logger.warn(`Ignoring the saved apps: ${(err as Error).message}`);
      apps = configured;
      this.savedStopped.clear();
      try {
        levels = dependencyLevels(apps);
      } catch (err2) {
        this.logger.error(`Not starting apps: ${(err2 as Error).message}`);
        return;
      }
    }
    this.startLevels = levels;

    const byName = new Map(apps.map((app) => [app.name, app]));
    const ready = new Map<string, Promise<boolean>>();
    for (const name of levels.flat()) {
      const app = byName.get(name);
      if (!app) continue;
      if (app.cron !== undefined) {
        // Scheduled jobs run when the scheduler plugin starts them, not with the daemon
        this.processes.set(app.name, this.placeholder(app, 'stopped', `scheduled: cron "${app.cron}"`));
        // Config apps are scheduled by the scheduler's own start; saved ones are announced here
        if (!configured.includes(app)) this.context.events.emit('cron:register', { config: app });
        ready.set(name, Promise.resolve(false));
        continue;
      }
      if (this.savedStopped.has(name)) {
        this.processes.set(name, this.placeholder(app, 'stopped', 'saved as stopped'));
        ready.set(name, Promise.resolve(false));
        continue;
      }
      ready.set(name, this.startWhenDependenciesReady(app, ready));
    }
    const independent = apps
      .filter((app) => (app.dependencies ?? []).length === 0 && app.cron === undefined)
      .map((app) => ready.get(app.name))
      .filter((p): p is Promise<boolean> => p !== undefined);
    await Promise.all(independent);
  }

  /**
   * Start an app once every dependency is ready; resolves whether it was started. Readiness of
   * this app (healthy, when it has a health check) is checked by its own dependents.
   */
  private async startWhenDependenciesReady(app: ProcessConfig, ready: Map<string, Promise<boolean>>): Promise<boolean> {
    const deps = app.dependencies ?? [];
    if (deps.length > 0) {
      this.markWaiting(app, `waiting for ${deps.join(', ')}`);
      const started = await Promise.all(deps.map((dep) => ready.get(dep) ?? Promise.resolve(false)));
      const failedDep = deps.find((_dep, i) => !started[i]);
      const notReady = failedDep ?? await this.waitForDependencies(deps, app.dependencyTimeout ?? 60000);
      // Stopped or deleted while waiting: the user cancelled it
      if (this.processes.get(app.name)?.status !== 'waiting') return false;
      if (notReady !== undefined) {
        this.markErrored(app, `dependency "${notReady}" did not become ready`);
        return false;
      }
    }

    try {
      await this.startProcess(app);
      return true;
    } catch (err) {
      this.logger.error(`Failed to start ${app.name}`, undefined, err as Error);
      return false;
    }
  }

  /**
   * Wait until every app is online, and healthy when it has a health check. Returns the first
   * app that is still not ready when the timeout passes, or undefined when all are ready.
   */
  private async waitForDependencies(names: string[], timeout: number): Promise<string | undefined> {
    const health = this.context.getPlugin('health-check') as unknown as
      { getReports?: (name?: string) => Array<{ status: string }> } | undefined;
    const isReady = (name: string): boolean => {
      const proc = this.processes.get(name);
      if (proc?.status !== 'online') return false;
      if (!proc.config.healthCheck || !health?.getReports) return true;
      return health.getReports(name)[0]?.status === 'healthy';
    };

    const deadline = Date.now() + timeout;
    while (!this.stopping) {
      const pending = names.find((name) => !isReady(name));
      if (pending === undefined) return undefined;
      if (Date.now() >= deadline) return pending;
      await new Promise((r) => setTimeout(r, 100));
    }
    return names[0];
  }

  /**
   * Show an app that has not started yet in `od list`, with the reason
   */
  private markWaiting(app: ProcessConfig, reason: string): void {
    this.processes.set(app.name, this.placeholder(app, 'waiting', reason));
  }

  private markErrored(app: ProcessConfig, reason: string): void {
    this.logger.error(`Not starting ${app.name}: ${reason}`);
    this.processes.set(app.name, this.placeholder(app, 'errored', reason));
  }

  private placeholder(app: ProcessConfig, status: ProcessStatus, reason: string): ManagedProcessInfo {
    const existing = this.processes.get(app.name);
    return {
      id: existing?.id ?? this.nextId++,
      config: app,
      status,
      pids: [],
      restartCount: existing?.restartCount ?? 0,
      failStreak: 0,
      workerPids: new Map(),
      customMetrics: new Map(),
      cpu: 0,
      memory: 0,
      logs: existing?.logs ?? [],
      statusReason: reason,
    };
  }

  /**
   * Stop the plugin
   */
  async onStop(): Promise<void> {
    this.stopping = true;
    this.logger.info('Process manager stopping');

    // Stop dependents before what they depend on: first anything started outside the config
    // (od start), then the configured apps level by level in reverse. Each group stops in parallel.
    const remaining = new Map(this.processes);
    const levels = [...this.startLevels].reverse().map((level) =>
      level.map((name) => remaining.get(name)).filter((p): p is ManagedProcessInfo => p !== undefined));
    for (const level of levels) for (const proc of level) remaining.delete(proc.config.name);
    const groups = [[...remaining.values()], ...levels];

    for (const group of groups) {
      await Promise.all(group.map(async (proc) => {
        try {
          await this.stopProcessInternal(proc, 'SIGTERM', proc.config.killTimeout ?? 5000);
        } catch (err) {
          this.logger.error(`Failed to stop ${proc.config.name}`, undefined, err as Error);
        }
      }));
    }
    this.processes.clear();
    // Everything stopped on purpose: nothing for a later daemon to clean up
    this.registry?.clear();
  }

  /**
   * List all processes
   */
  private listProcesses(): Promise<ProcessInfo[]> {
    return Promise.resolve(Array.from(this.processes.values()).map((proc) => this.toProcessInfo(proc)));
  }

  /**
   * Get process info by name
   */
  private getProcessInfo(params: { name: string }): Promise<ProcessInfo | null> {
    const proc = this.processes.get(params.name);
    return Promise.resolve(proc ? this.toProcessInfo(proc) : null);
  }

  /**
   * `start` over IPC. A scheduled job (`cron`) is registered with the scheduler and shown as
   * stopped until its next tick, instead of running now; the scheduler itself starts runs through
   * startProcessFromPlugin.
   */
  private async startFromRpc(config: ProcessConfig): Promise<ProcessInfo> {
    if (config.cron === undefined) return this.startProcess(config);
    const existing = this.processes.get(config.name);
    if (existing && existing.status !== 'stopped' && existing.status !== 'errored' && existing.status !== 'waiting') {
      throw new ProcessError(ErrorCode.PROCESS_ALREADY_EXISTS, config.name, `Process "${config.name}" already exists`);
    }
    this.validateConfig(config);
    const info = this.placeholder(config, 'stopped', `scheduled: cron "${config.cron}"`);
    this.processes.set(config.name, info);
    this.context.events.emit('cron:register', { config });
    return this.toProcessInfo(info);
  }

  /**
   * Start a process
   */
  private async startProcess(config: ProcessConfig): Promise<ProcessInfo> {
    // Check if already exists
    const existing = this.processes.get(config.name);
    if (existing && existing.status !== 'stopped' && existing.status !== 'errored' && existing.status !== 'waiting') {
      throw new ProcessError(
        ErrorCode.PROCESS_ALREADY_EXISTS,
        config.name,
        `Process "${config.name}" already exists`
      );
    }

    // Validate config
    this.validateConfig(config);

    // Check there is something to run (a script file, a program with an interpreter, or a command)
    const launch = resolveLaunch(config);
    if ('error' in launch) {
      throw new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, config.name, launch.error);
    }
    if (config.mode === 'cluster' && !launch.node) {
      throw new ProcessError(
        ErrorCode.PROCESS_INVALID_CONFIG,
        config.name,
        'Cluster mode runs Node.js scripts only; use mode: fork for other programs'
      );
    }

    // Create process info
    const proc: ManagedProcessInfo = {
      id: existing?.id ?? this.nextId++,
      config,
      status: 'starting',
      pids: [],
      restartCount: existing?.restartCount ?? 0,
      failStreak: 0,
      workerPids: new Map(),
      customMetrics: new Map(),
      cpu: 0,
      memory: 0,
      logs: existing?.logs ?? [],
    };

    this.processes.set(config.name, proc);

    try {
      // Start the process
      if (config.mode === 'cluster') {
        await this.startCluster(proc);
      } else {
        await this.startFork(proc);
      }

      proc.status = 'online';
      proc.startTime = new Date();

      // Start metrics collection
      this.startMetricsCollection(proc);
      this.armCronRestart(proc);

      this.logger.info(`Process started: ${config.name}`, { pid: proc.pid });
      this.context.events.emit('process:started', { name: config.name, pid: proc.pid });

      return this.toProcessInfo(proc);
    } catch (err) {
      proc.status = 'errored';
      this.logger.error(`Failed to start process ${config.name}:`, undefined, err as Error);
      throw err;
    }
  }

  /**
   * Stop a process
   */
  private async stopProcess(params: { name: string; signal?: string; timeout?: number; cascade?: boolean }): Promise<string[]> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      throw new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`);
    }

    // Dependents go first, so nothing is left running against a dependency that is gone
    const stopped: string[] = [];
    for (const dependent of params.cascade === true ? this.runningDependents(params.name) : []) {
      await this.stopProcessInternal(dependent, params.signal ?? 'SIGTERM', params.timeout ?? (dependent.config.killTimeout ?? 5000));
      stopped.push(dependent.config.name);
    }
    await this.stopProcessInternal(
      proc,
      params.signal ?? 'SIGTERM',
      params.timeout ?? (proc.config.killTimeout ?? 5000)
    );
    return [...stopped, params.name];
  }

  /**
   * Running apps that depend on `name`, directly or not, ordered so each comes before what it
   * depends on (the order to stop them in; reverse it to start them)
   */
  private runningDependents(name: string): ManagedProcessInfo[] {
    const ordered: ManagedProcessInfo[] = [];
    const seen = new Set<string>([name]);
    const visit = (target: string): void => {
      for (const proc of this.processes.values()) {
        const dependent = proc.config.name;
        if (seen.has(dependent) || !(proc.config.dependencies ?? []).includes(target)) continue;
        seen.add(dependent);
        visit(dependent);
        if (proc.status === 'online' || proc.status === 'starting') ordered.push(proc);
      }
    };
    visit(name);
    return ordered;
  }

  /**
   * Restart a process; with `cascade`, the apps that depend on it are stopped first and started
   * again, in dependency order, once it is ready
   */
  private async restartProcess(params: { name: string; cascade?: boolean; env?: Record<string, string> }): Promise<ProcessInfo> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      throw new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`);
    }
    // New environment for this and later runs (od restart api --env KEY=value)
    if (params.env !== undefined && Object.keys(params.env).length > 0) {
      proc.config = { ...proc.config, env: { ...proc.config.env, ...params.env } };
    }

    const dependents = params.cascade === true ? this.runningDependents(params.name) : [];
    const configs = dependents.map((dependent) => dependent.config);
    for (const dependent of dependents) {
      await this.stopProcessInternal(dependent, 'SIGTERM', dependent.config.killTimeout ?? 5000);
    }
    await this.stopProcessInternal(proc, 'SIGTERM', proc.config.killTimeout ?? 5000);
    const info = await this.startProcess(proc.config);

    for (const config of configs.reverse()) {
      const notReady = await this.waitForDependencies(config.dependencies ?? [], config.dependencyTimeout ?? 60000);
      if (notReady !== undefined) {
        this.markErrored(config, `dependency "${notReady}" did not become ready`);
        continue;
      }
      await this.startProcess(config);
    }
    return info;
  }

  /**
   * Restart the process at each match of its `cronRestart` expression (PM2's cron_restart). The
   * timer belongs to this run: stopping or restarting the process replaces it.
   */
  private armCronRestart(proc: ManagedProcessInfo): void {
    clearTimeout(proc.cronRestartTimer);
    const expression = proc.config.cronRestart;
    if (expression === undefined || proc.config.cron !== undefined) return;
    let at: Date | undefined;
    try {
      at = nextRun(parseCron(expression), new Date(), proc.config.cronTimezone);
    } catch (err) {
      this.logger.error(`Ignoring cronRestart of ${proc.config.name}: ${(err as Error).message}`);
      return;
    }
    if (at === undefined) return;
    const target = at;
    const wait = (): void => {
      // setTimeout cannot wait longer than ~24.8 days: longer waits are re-armed in chunks
      proc.cronRestartTimer = setTimeout(() => {
        if (Date.now() < target.getTime()) { wait(); return; }
        if (this.processes.get(proc.config.name) !== proc || proc.status !== 'online') {
          this.armCronRestart(proc);
          return;
        }
        this.logger.info(`Restarting ${proc.config.name} (cronRestart ${expression})`);
        // The restart starts a new run, which arms its own timer
        this.restartProcess({ name: proc.config.name }).catch((err: unknown) => {
          this.logger.error(`Scheduled restart of ${proc.config.name} failed`, undefined, err as Error);
        });
      }, Math.min(Math.max(target.getTime() - Date.now(), 0), 2 ** 31 - 1));
      proc.cronRestartTimer.unref();
    };
    wait();
  }

  /**
   * The environment an app is configured with (pm2 env): values as written, secret references
   * by name, never the secrets themselves
   */
  private processEnv(params: { name: string }): Promise<Record<string, string>> {
    const proc = this.processes.get(params.name);
    if (!proc) return Promise.reject(new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`));
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(proc.config.env ?? {}) as Array<[string, unknown]>) {
      out[key] = typeof value === 'object' && value !== null ? `{secret:${String((value as { secret?: unknown }).secret)}}` : String(value);
    }
    return Promise.resolve(out);
  }

  /**
   * Zero the restart counter of one process, or of all (pm2 reset)
   */
  private resetProcess(params?: { name?: string }): Promise<string[]> {
    const names = params?.name === undefined ? [...this.processes.keys()] : [params.name];
    const missing = names.find((name) => !this.processes.has(name));
    if (missing !== undefined) {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_NOT_FOUND, missing, `Process "${missing}" not found`));
    }
    for (const name of names) {
      const proc = this.processes.get(name);
      if (proc) { proc.restartCount = 0; proc.failStreak = 0; }
    }
    return Promise.resolve(names);
  }

  /**
   * Send a signal to a running process (pm2 sendSignal): to every worker in cluster mode, to the
   * process itself otherwise. Returns the pids that were signalled.
   */
  private signalProcess(params: { name: string; signal: string }): Promise<number[]> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`));
    }
    const signal = params.signal.toUpperCase().startsWith('SIG') ? params.signal.toUpperCase() : `SIG${params.signal.toUpperCase()}`;
    if (!(signal in osConstants.signals)) {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, params.name, `Unknown signal "${params.signal}"`));
    }
    if (proc.status !== 'online') {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, params.name, `Process "${params.name}" is ${proc.status}, not online`));
    }
    const pids = proc.config.mode === 'cluster' && proc.workerPids.size > 0 ? [...proc.workerPids.values()] : proc.pid === undefined ? [] : [proc.pid];
    const sent: number[] = [];
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
        sent.push(pid);
      } catch { /* already gone */ }
    }
    this.logger.info(`Sent ${signal} to ${params.name} (${sent.join(', ')})`);
    return Promise.resolve(sent);
  }

  /**
   * Delete a process
   */
  private async deleteProcess(params: { name: string }): Promise<void> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      throw new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`);
    }

    if (proc.status === 'online' || proc.status === 'starting') {
      await this.stopProcessInternal(proc, 'SIGTERM', proc.config.killTimeout ?? 5000);
    }

    this.processes.delete(params.name);
    this.logger.info(`Process deleted: ${params.name}`);
    this.context.events.emit('process:deleted', { name: params.name });
  }

  /**
   * Start metrics collection for a process
   */
  private startMetricsCollection(proc: ManagedProcessInfo): void {
    // Clear existing interval
    if (proc.metricsInterval) {
      clearInterval(proc.metricsInterval);
    }

    // Sample right away so memory shows up immediately and CPU has a baseline
    this.collectMetrics(proc);
    proc.metricsInterval = setInterval(() => {
      this.collectMetrics(proc);
    }, 2000);
  }

  /**
   * Stop metrics collection for a process
   */
  private stopMetricsCollection(proc: ManagedProcessInfo): void {
    if (proc.metricsInterval) {
      clearInterval(proc.metricsInterval);
      proc.metricsInterval = undefined;
    }
  }

  /**
   * Collect CPU and memory metrics for a process.
   * Values are read from the managed pids themselves, never from the daemon.
   */
  private collectMetrics(proc: ManagedProcessInfo): void {
    const pids = proc.pids.filter((pid) => pid > 0);
    if (pids.length === 0) {
      proc.cpu = 0;
      proc.memory = 0;
      return;
    }

    if (process.platform === 'linux') {
      this.collectProcMetrics(proc, pids);
    } else if (process.platform !== 'win32') {
      this.collectPsMetrics(proc, pids);
    }
    // Windows: no dependency-free per-pid source, metrics stay 0
  }

  /**
   * Linux: CPU % from utime+stime deltas in /proc/<pid>/stat, memory from VmRSS
   */
  private collectProcMetrics(proc: ManagedProcessInfo, pids: number[]): void {
    const now = Date.now();
    const samples = (proc.cpuSamples ??= new Map<number, { ticks: number; at: number }>());
    let cpu = 0;
    let memory = 0;

    for (const pid of pids) {
      try {
        // Fields after the ")" that ends comm: utime and stime are the 12th and 13th
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ticks = Number(fields[11]) + Number(fields[12]);

        const previous = samples.get(pid);
        if (previous && now > previous.at) {
          const cpuSeconds = (ticks - previous.ticks) / ProcessManagerPlugin.CLOCK_TICKS;
          cpu += (cpuSeconds / ((now - previous.at) / 1000)) * 100;
        }
        samples.set(pid, { ticks, at: now });

        const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
        const rss = status.match(/VmRSS:\s+(\d+)\s+kB/)?.[1];
        if (rss) {
          memory += parseInt(rss, 10) * 1024;
        }
      } catch {
        // Process might have exited between listing and reading
        samples.delete(pid);
      }
    }

    // Forget samples of pids that are no longer managed (restarts, scaled workers)
    for (const pid of samples.keys()) {
      if (!pids.includes(pid)) samples.delete(pid);
    }

    proc.cpu = Math.max(0, cpu);
    proc.memory = memory;
    const limits = this.effectiveLimits(proc.config);
    if (limits.fds) proc.fds = this.countFds(pids);
    if (limits.children) proc.children = this.countDescendants(pids);
    this.enforceLimits(proc);
  }

  /**
   * Linux: open file descriptors of the pids together
   */
  private countFds(pids: number[]): number {
    let total = 0;
    for (const pid of pids) {
      try {
        total += readdirSync(`/proc/${pid}/fd`).length;
      } catch {
        // Gone, or not ours to read
      }
    }
    return total;
  }

  /**
   * Linux: all descendants of the pids, from /proc/<pid>/task/<tid>/children
   */
  private countDescendants(pids: number[]): number {
    const seen = new Set<number>();
    const queue = [...pids];
    for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
      let tasks: string[];
      try {
        tasks = readdirSync(`/proc/${pid}/task`);
      } catch {
        continue;
      }
      for (const task of tasks) {
        let children = '';
        try {
          children = readFileSync(`/proc/${pid}/task/${task}/children`, 'utf-8');
        } catch {
          // Kernel without CONFIG_PROC_CHILDREN, or the thread exited
        }
        for (const child of children.split(' ').map(Number)) {
          if (child > 0 && !seen.has(child)) {
            seen.add(child);
            queue.push(child);
          }
        }
      }
    }
    return seen.size;
  }

  /**
   * macOS / other Unix: ask ps for rss (kB) and %cpu of the managed pids
   */
  private collectPsMetrics(proc: ManagedProcessInfo, pids: number[]): void {
    execFile('ps', ['-o', 'rss=,%cpu=', '-p', pids.join(',')], (err, stdout) => {
      if (err) return;
      let cpu = 0;
      let memory = 0;
      for (const line of stdout.trim().split('\n')) {
        const [rss, pcpu] = line.trim().split(/\s+/);
        memory += (Number(rss) || 0) * 1024;
        cpu += Number(pcpu) || 0;
      }
      proc.cpu = cpu;
      proc.memory = memory;
      this.enforceLimits(proc);
    });
  }

  /**
   * The limits that apply to a process: `limits`, with maxMemory / maxCpu as shorthands
   */
  private effectiveLimits(config: ProcessConfig): {
    memory?: { max: number; action: LimitAction; grace: number };
    cpu?: { max: number; action: LimitAction; duration: number };
    fds?: { max: number; action: LimitAction; grace: number };
    children?: { max: number; action: LimitAction; grace: number };
    eventLoop?: { max: number; action: LimitAction; grace: number };
  } {
    const count = (limit: CountLimit | undefined) => limit === undefined ? {} : {
      max: limit.max, action: limit.action ?? 'warn', grace: limit.grace ?? 0,
    };
    const memoryMax = config.limits?.memory?.max ?? config.maxMemory;
    const memoryBytes = memoryMax === undefined ? undefined : parseBytes(memoryMax);
    const cpuMax = config.limits?.cpu?.max ?? config.maxCpu;
    return {
      ...(memoryBytes === undefined ? {} : {
        memory: { max: memoryBytes, action: config.limits?.memory?.action ?? 'restart', grace: config.limits?.memory?.grace ?? 0 },
      }),
      ...(cpuMax === undefined ? {} : {
        cpu: { max: cpuMax, action: config.limits?.cpu?.action ?? 'warn', duration: config.limits?.cpu?.duration ?? 60000 },
      }),
      ...(config.limits?.fds === undefined ? {} : { fds: count(config.limits.fds) as { max: number; action: LimitAction; grace: number } }),
      ...(config.limits?.children === undefined ? {} : { children: count(config.limits.children) as { max: number; action: LimitAction; grace: number } }),
      ...(config.limits?.eventLoop === undefined ? {} : { eventLoop: count(config.limits.eventLoop) as { max: number; action: LimitAction; grace: number } }),
    };
  }

  /**
   * Compare the latest sample with the process's limits; a limit that stays exceeded for its
   * grace/duration triggers its action once (a restart starts fresh, 'warn' re-arms when the
   * value drops back under the limit)
   */
  private enforceLimits(proc: ManagedProcessInfo): void {
    if (proc.status !== 'online') return;
    const limits = this.effectiveLimits(proc.config);
    const state = (proc.limitState ??= {});
    const now = Date.now();

    const check = (
      kind: LimitKind, value: number, max: number, hold: number, action: LimitAction
    ): void => {
      if (value <= max) {
        // Back under the limit: forget the breach so a later one starts a new grace period
        state[kind] = undefined;
        return;
      }
      const entry = (state[kind] ??= { since: now, acted: false });
      if (entry.acted || now - entry.since < hold) return;
      entry.acted = true;
      this.applyLimitAction(proc, kind, value, max, action);
    };

    if (limits.memory) check('memory', proc.memory, limits.memory.max, limits.memory.grace, limits.memory.action);
    if (limits.cpu) check('cpu', proc.cpu, limits.cpu.max, limits.cpu.duration, limits.cpu.action);
    if (limits.fds && proc.fds !== undefined) check('fds', proc.fds, limits.fds.max, limits.fds.grace, limits.fds.action);
    if (limits.eventLoop) {
      const delay = this.eventLoopDelay(proc);
      if (delay !== undefined) check('eventLoop', delay, limits.eventLoop.max, limits.eventLoop.grace, limits.eventLoop.action);
    }
    if (limits.children && proc.children !== undefined) check('children', proc.children, limits.children.max, limits.children.grace, limits.children.action);
  }

  /**
   * The worst event loop delay (p99, ms) the instances reported, if any did
   */
  private eventLoopDelay(proc: ManagedProcessInfo): number | undefined {
    let worst: number | undefined;
    for (const snapshots of proc.customMetrics.values()) {
      const gauge = snapshots.find((m) => m.name === 'nodejs_eventloop_delay_p99_seconds');
      for (const series of gauge?.series ?? []) {
        if (series.value !== undefined) worst = Math.max(worst ?? 0, series.value * 1000);
      }
    }
    return worst;
  }

  private applyLimitAction(proc: ManagedProcessInfo, kind: LimitKind, value: number, limit: number, action: LimitAction): void {
    const name = proc.config.name;
    const unit = { memory: ' bytes', cpu: '%', fds: ' open files', children: ' child processes', eventLoop: ' ms event loop delay' }[kind];
    this.logger.warn(`Process "${name}" ${kind} ${value.toFixed(kind === 'cpu' ? 1 : 0)}${unit} exceeds the limit (${String(limit)}${unit}); action: ${action}`);
    this.context.events.emit(`process:${kind}-limit`, { name, [kind]: value, limit, action });

    if (action === 'restart') {
      proc.restartCount++;
      proc.lastRestart = new Date();
      this.restartProcess({ name }).catch((err: unknown) => {
        this.logger.error(`Limit restart failed: ${name}`, undefined, err as Error);
      });
    } else if (action === 'stop') {
      this.stopProcess({ name }).catch((err: unknown) => {
        this.logger.error(`Limit stop failed: ${name}`, undefined, err as Error);
      });
    }
  }

  // Linux USER_HZ; 100 on every mainstream architecture
  private static readonly CLOCK_TICKS = 100;

  private static readonly MAX_LOG_LINES = 500;
  /** A run this long (ms) is stable, unless the app sets stableAfter or minUptime */
  private static readonly STABLE_AFTER = 10000;

  /**
   * Capture stdout/stderr from a child process into the log buffer
   */
  private captureOutput(proc: ManagedProcessInfo, child: ChildProcess, instanceId?: number): void {
    const capture = (source: 'stdout' | 'stderr', stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      // A chunk can end mid-line, so keep the unterminated tail until the next chunk
      let pending = '';
      const emit = (line: string) => {
        const text = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (text.length > 0) this.appendLog(proc, source, text, child.pid, instanceId);
      };
      stream.setEncoding('utf-8');
      stream.on('data', (chunk: string) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        lines.forEach(emit);
      });
      stream.on('end', () => {
        emit(pending);
        pending = '';
      });
    };

    capture('stdout', child.stdout);
    capture('stderr', child.stderr);
  }

  /**
   * Append a log entry, keeping the buffer bounded
   */
  private appendLog(
    proc: ManagedProcessInfo,
    level: 'stdout' | 'stderr',
    message: string,
    pid?: number,
    instanceId?: number
  ): void {
    const timestamp = new Date().toISOString();
    proc.logs.push({
      timestamp,
      level,
      message,
    });

    // Persisted and streamed by the log-manager plugin
    const entry: ProcessLogEntry = {
      timestamp,
      level: level === 'stderr' ? 'error' : 'info',
      pid: pid ?? 0,
      processName: proc.config.name,
      ...(instanceId === undefined ? {} : { instanceId }),
      message,
      source: level,
    };
    this.context.events.emit('process:log', entry);
    // Trim oldest entries when buffer exceeds limit
    if (proc.logs.length > ProcessManagerPlugin.MAX_LOG_LINES) {
      proc.logs.splice(0, proc.logs.length - ProcessManagerPlugin.MAX_LOG_LINES);
    }
  }

  /**
   * Change the number of workers of a running cluster without restarting it
   */
  private scaleProcess(params: { name: string; instances: unknown }): Promise<ProcessInfo> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`));
    }
    if (proc.config.mode !== 'cluster') {
      return Promise.reject(new ProcessError(
        ErrorCode.PROCESS_INVALID_CONFIG, params.name,
        `Process "${params.name}" runs in fork mode; scaling needs mode: cluster`
      ));
    }
    const requested = params.instances === 'max' ? 'max' : Number(params.instances);
    if (requested !== 'max' && (!Number.isInteger(requested) || requested < 1)) {
      return Promise.reject(new ProcessError(
        ErrorCode.PROCESS_INVALID_CONFIG, params.name, `Instances must be a positive integer or "max"`
      ));
    }

    // Persist it, so a later restart of the whole cluster keeps the new size
    proc.config = { ...proc.config, instances: requested };
    const primary = proc.childProcess;
    if (primary?.connected) {
      primary.send({ type: 'od:scale', instances: this.resolveInstances(proc.config) });
    }
    this.logger.info(`Scaled ${params.name} to ${String(this.resolveInstances(proc.config))} instances`);
    return Promise.resolve(this.toProcessInfo(proc));
  }

  /**
   * Get logs for a process (RPC handler)
   */
  private getProcessLogs(params: { name: string; lines?: number }): Promise<LogEntry[]> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`));
    }
    const lines = params.lines ?? 100;
    return Promise.resolve(proc.logs.slice(-lines));
  }

  /**
   * Start process in fork mode
   */
  private async startFork(proc: ManagedProcessInfo): Promise<void> {
    const config = proc.config;
    const launch = resolveLaunch(config);
    if ('error' in launch) throw new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, config.name, launch.error);
    // A command without a file has no directory of its own: it runs where the daemon was asked to
    const cwd = config.cwd ? resolve(config.cwd) : existsSync(resolve(config.script)) ? dirname(resolve(config.script)) : process.cwd();

    const env = this.buildEnv(config);

    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      // Its own process group (POSIX): the whole tree can be stopped, and it does not get the
      // terminal's Ctrl+C meant for the daemon
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      shell: launch.shell === true,
    });

    proc.childProcess = child;
    proc.pid = child.pid;
    if (child.pid) {
      proc.pids = [child.pid];
      this.registry?.add(child.pid, config.name);
    }

    // Capture stdout/stderr
    this.captureOutput(proc, child);

    child.on('message', (message: unknown) => {
      if (proc.childProcess !== child) return;
      const metrics = metricsFrom(message);
      if (metrics) proc.customMetrics.set('', metrics);
    });

    // Handle process events
    child.on('exit', (code, signal) => {
      if (child.pid) this.registry?.remove(child.pid);
      // What the process started and left running would hold its ports when it is restarted
      if (groupAlive(child.pid)) killTree(child.pid, 'SIGKILL');
      if (proc.childProcess === child) proc.customMetrics.clear();
      this.handleProcessExit(proc, code, signal);
    });

    child.on('error', (err) => {
      this.logger.error(`Process error: ${config.name}`, undefined, err);
      proc.status = 'errored';
      this.context.events.emit('process:error', { name: config.name, error: err.message });
    });

    // Wait for process to be ready (optional): its own 'ready' message (waitReady, PM2's
    // wait_ready), or minUptime
    if (config.waitReady === true) {
      await this.waitForReady(child, config.listenTimeout ?? 3000);
    } else if (config.minUptime) {
      await this.waitForReady(child, config.minUptime);
    }
  }

  /**
   * Start process in cluster mode: one cluster primary (cluster-primary.mjs) forks the app as
   * node:cluster workers so they can share listening ports. The primary restarts crashed workers
   * and reports worker pids, logs and readiness over IPC; the daemon manages the primary like a
   * forked process.
   */
  private async startCluster(proc: ManagedProcessInfo): Promise<void> {
    const config = proc.config;
    const scriptPath = resolve(config.script);
    const cwd = config.cwd ? resolve(config.cwd) : dirname(scriptPath);
    const instances = this.resolveInstances(config);

    const env = {
      ...this.buildEnv(config),
      OD_CLUSTER_SCRIPT: scriptPath,
      OD_CLUSTER_INSTANCES: String(instances),
      OD_CLUSTER_ARGS: JSON.stringify(config.args ?? []),
      OD_CLUSTER_POLICY: JSON.stringify({
        autoRestart: config.autoRestart,
        restartDelay: config.restartDelay,
        maxRestarts: config.maxRestarts,
        killTimeout: config.killTimeout,
        stableAfter: config.stableAfter ?? config.minUptime,
        stopExitCodes: config.stopExitCodes,
      }),
    };

    const child = spawn(process.execPath, [clusterPrimaryPath()], {
      cwd,
      env,
      // Its own process group (POSIX): the whole tree can be stopped, and it does not get the
      // terminal's Ctrl+C meant for the daemon
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    proc.childProcess = child;
    proc.pid = child.pid;
    proc.pids = child.pid ? [child.pid] : [];
    if (child.pid) this.registry?.add(child.pid, config.name);
    proc.workerPids = new Map();

    // The primary's own output (startup errors); worker output arrives as od:log messages
    this.captureOutput(proc, child);

    child.on('message', (message: unknown) => {
      this.handleClusterMessage(proc, child, message);
    });
    child.on('exit', (code, signal) => {
      if (child.pid) this.registry?.remove(child.pid);
      // What the process started and left running would hold its ports when it is restarted
      if (groupAlive(child.pid)) killTree(child.pid, 'SIGKILL');
      if (proc.childProcess === child) {
        proc.workerPids.clear();
        proc.customMetrics.clear();
        for (const waiter of proc.deployWaiters?.values() ?? []) waiter({ ok: false, error: 'the cluster primary exited' });
      }
      this.handleProcessExit(proc, code, signal);
    });
    child.on('error', (err) => {
      this.logger.error(`Cluster primary error: ${config.name}`, undefined, err);
      proc.status = 'errored';
      this.context.events.emit('process:error', { name: config.name, error: err.message });
    });

    if (config.minUptime) {
      await this.waitForReady(child, config.minUptime);
    }
  }

  private handleClusterMessage(proc: ManagedProcessInfo, primary: ChildProcess, message: unknown): void {
    // Ignore a previous primary that is still shutting down
    if (proc.childProcess !== primary || typeof message !== 'object' || message === null) return;
    const msg = message as {
      type?: string; event?: string; index?: number; pid?: number;
      source?: 'stdout' | 'stderr'; message?: string; code?: number | null; signal?: string | null;
    };
    const deploy = message as { type?: string; id?: string; ok?: boolean; error?: string; pid?: number };
    if (deploy.type === 'od:deploy' && typeof deploy.id === 'string') {
      proc.deployWaiters?.get(deploy.id)?.({ ok: deploy.ok === true, ...(deploy.error === undefined ? {} : { error: deploy.error }), ...(deploy.pid === undefined ? {} : { pid: deploy.pid }) });
      return;
    }
    if (typeof msg.index !== 'number') return;

    const metrics = metricsFrom(message);
    if (metrics) {
      proc.customMetrics.set(String(msg.index), metrics);
      return;
    }
    if (msg.type === 'od:log' && typeof msg.message === 'string') {
      this.appendLog(proc, msg.source === 'stderr' ? 'stderr' : 'stdout', msg.message, msg.pid, msg.index);
      return;
    }
    if (msg.type !== 'od:worker') return;

    if (msg.event === 'online' && typeof msg.pid === 'number') {
      proc.workerPids.set(msg.index, msg.pid);
    } else if (msg.event === 'exit') {
      proc.workerPids.delete(msg.index);
      proc.customMetrics.delete(String(msg.index));
      this.logger.info(`Worker exited: ${proc.config.name}[${String(msg.index)}]`, { code: msg.code, signal: msg.signal });
      this.context.events.emit('process:worker-exit', { name: proc.config.name, index: msg.index, code: msg.code, signal: msg.signal });
    } else if (msg.event === 'restart') {
      // Worker crash restarts count like process restarts, so `od list` shows the crash loop
      proc.restartCount++;
      proc.lastRestart = new Date();
    }
    proc.pids = [...(primary.pid ? [primary.pid] : []), ...proc.workerPids.values()];
  }

  /**
   * Number of cluster workers: a number, or 'max' for one per CPU
   */
  private resolveInstances(config: ProcessConfig): number {
    if (config.instances === 'max') return Math.max(1, availableParallelism());
    return typeof config.instances === 'number' && config.instances > 0 ? config.instances : 1;
  }

  /**
   * Stop process internal
   */
  private async stopProcessInternal(
    proc: ManagedProcessInfo,
    signal: string,
    timeout: number
  ): Promise<void> {
    if (proc.status === 'stopped' || proc.status === 'stopping') {
      return;
    }

    proc.status = 'stopping';
    this.logger.info(`Stopping process: ${proc.config.name}`);

    // Stop metrics collection
    this.stopMetricsCollection(proc);
    clearTimeout(proc.cronRestartTimer);
    proc.cronRestartTimer = undefined;

    // Clear any pending restart timeouts
    if (proc.stopTimeout) {
      clearTimeout(proc.stopTimeout);
      proc.stopTimeout = undefined;
    }

    // `killed` only means a signal was delivered, not that the child exited,
    // so liveness is judged by exitCode/signalCode instead
    const isAlive = (child: ChildProcess | undefined): child is ChildProcess =>
      child !== undefined && child.exitCode === null && child.signalCode === null;
    const children = [proc.childProcess].filter(isAlive);

    // Signal the process and what it started (in cluster mode the primary also forwards it to its workers)
    const groups = children.map((child) => child.pid);
    for (const child of children) {
      killTree(child.pid, signal as NodeJS.Signals);
    }

    // Wait for the process, and the rest of its tree, to exit
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!children.some(isAlive) && !groups.some((pid) => groupAlive(pid))) {
        break;
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    // Force kill what is still running
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null || groupAlive(child.pid)) {
        killTree(child.pid, 'SIGKILL');
      }
    }

    // A force-killed primary (or one on Windows, where kill() cannot be caught) cannot stop its
    // workers, so kill any reported worker that is still alive
    for (const pid of proc.workerPids.values()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }

    proc.status = 'stopped';
    proc.pid = undefined;
    proc.pids = [];
    proc.childProcess = undefined;
    proc.workerPids = new Map();
    proc.cpu = 0;
    proc.memory = 0;
    proc.cpuSamples = undefined;

    this.logger.info(`Process stopped: ${proc.config.name}`);
    this.context.events.emit('process:stopped', { name: proc.config.name });
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(
    proc: ManagedProcessInfo,
    code: number | null,
    signal: string | null
  ): void {
    // Exits caused by a daemon shutdown or an explicit stop must not trigger auto-restart
    if (this.stopping || proc.status === 'stopping' || proc.status === 'stopped') {
      return;
    }

    this.logger.info(`Process exited: ${proc.config.name}`, { code, signal });
    if (code !== 0) {
      // An unexpected non-zero exit or signal, whether or not it will be restarted
      this.context.events.emit('process:crash', {
        name: proc.config.name, code, signal, restartCount: proc.restartCount, pid: proc.pid,
      });
    }

    // Stop metrics collection
    this.stopMetricsCollection(proc);

    // A run that lasted long enough was stable: what crashed before no longer counts against
    // maxRestarts, so an app that fails once a day is never given up on
    const uptime = proc.startTime ? Date.now() - proc.startTime.getTime() : 0;
    if (uptime >= (proc.config.stableAfter ?? proc.config.minUptime ?? ProcessManagerPlugin.STABLE_AFTER)) proc.failStreak = 0;

    // Check if should restart
    const shouldRestart = this.shouldRestart(proc, code);

    if (shouldRestart) {
      proc.failStreak++;
      proc.restartCount++;
      proc.lastRestart = new Date();
      proc.status = 'starting';

      this.logger.info(`Restarting process: ${proc.config.name}`, {
        restartCount: proc.restartCount,
      });

      // Clear any existing timeout
      if (proc.stopTimeout) {
        clearTimeout(proc.stopTimeout);
      }

      const delay = this.calculateRestartDelay(proc);

      proc.stopTimeout = setTimeout(() => {
        proc.stopTimeout = undefined;
        if (proc.status === 'stopping' || proc.status === 'stopped') {
          return;
        }
        if (proc.config.mode === 'cluster') {
          this.startCluster(proc).then(() => {
            proc.status = 'online';
            proc.startTime = new Date();
            this.startMetricsCollection(proc);
          }).catch((err: unknown) => {
            this.logger.error(`Failed to restart cluster: ${proc.config.name}`, undefined, err as Error);
            proc.status = 'errored';
          });
        } else {
          this.startFork(proc).then(() => {
            proc.status = 'online';
            proc.startTime = new Date();
            this.startMetricsCollection(proc);
          }).catch((err: unknown) => {
            this.logger.error(`Failed to restart: ${proc.config.name}`, undefined, err as Error);
            proc.status = 'errored';
          });
        }
      }, delay);
    } else {
      proc.status = code === 0 ? 'stopped' : 'errored';
      this.context.events.emit('process:exit', { name: proc.config.name, code, signal });
    }
  }

  /**
   * Calculate restart delay with backoff
   */
  private calculateRestartDelay(proc: ManagedProcessInfo): number {
    const baseDelay = proc.config.restartDelay ?? 1000;
    const strategy = proc.config.backoffStrategy ?? 'fixed';
    const multiplier = proc.config.backoffMultiplier ?? 2;
    const maxDelay = proc.config.maxBackoffDelay ?? 30000;

    switch (strategy) {
      case 'linear':
        return Math.min(baseDelay * proc.failStreak, maxDelay);
      case 'exponential': {
        const delay = baseDelay * Math.pow(multiplier, proc.failStreak - 1);
        const jitter = delay * 0.1 * Math.random();
        return Math.min(delay + jitter, maxDelay);
      }
      case 'fixed':
      default:
        return baseDelay;
    }
  }

  /**
   * Check if process should restart
   */
  private shouldRestart(proc: ManagedProcessInfo, code: number | null): boolean {
    const strategy = proc.config.autoRestart;

    if (strategy === false || strategy === 'never') {
      return false;
    }

    if (strategy === 'unless-stopped' && proc.status === 'stopping') {
      return false;
    }

    if (strategy === 'on-failure' && code === 0) {
      return false;
    }

    // Exit codes that mean "done, do not bring me back" (PM2's stop_exit_codes)
    if (code !== null && (proc.config.stopExitCodes ?? []).includes(code)) {
      this.logger.info(`${proc.config.name} exited with ${String(code)}, which is in stopExitCodes: not restarting`);
      return false;
    }

    // Check max restarts
    const maxRestarts = proc.config.maxRestarts ?? 10;
    if (proc.failStreak >= maxRestarts) {
      this.logger.warn(`Max restarts reached for ${proc.config.name}`);
      return false;
    }

    return true;
  }

  /**
   * Wait for process to be ready
   */
  private waitForReady(child: ChildProcess, timeout: number): Promise<void> {
    // Started once the app sends 'ready', or if it is still running after `timeout` ms
    // (spec: "ready signal or timeout"); exiting before either is a failed start
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      const onMessage = (msg: unknown) => {
        if (msg === 'ready' || (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'ready')) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: string | null) => {
        cleanup();
        reject(new Error(`Process exited before it was ready (code ${String(code)}, signal ${String(signal)})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeout);

      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  }

  /**
   * Build environment variables
   */
  private buildEnv(config: ProcessConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Secret references ({ secret: 'NAME' }) are decrypted here, at start, and only ever live
    // in the child's environment
    const secrets = this.context.getPlugin('secret-manager') as unknown as
      { resolve(ref: { secret: string; version?: number }): string } | undefined;
    // Values come from config files, so anything can arrive here (YAML `PORT: 3000` is a number)
    for (const [key, value] of Object.entries(config.env ?? {}) as Array<[string, unknown]>) {
      if (typeof value === 'string') {
        env[key] = value;
      } else if (typeof value === 'object' && typeof (value as { secret?: unknown }).secret === 'string') {
        if (!secrets) {
          throw new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, config.name, `env.${key} references a secret, but the secret manager is not available`);
        }
        try {
          env[key] = secrets.resolve(value as { secret: string; version?: number });
        } catch (err) {
          throw new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, config.name, `env.${key}: ${(err as Error).message}`);
        }
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        env[key] = String(value);
      } else {
        throw new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, config.name, `env.${key} must be a string, number, boolean or { secret: NAME }`);
      }
    }

    // Add OpenDaemon metadata
    env['OD_PROCESS_NAME'] = config.name;
    env['OD_MANAGED'] = '1';
    // PM2 apps tell their instances apart by NODE_APP_INSTANCE (cluster workers get their index)
    env['NODE_APP_INSTANCE'] ??= '0';

    return env;
  }

  /**
   * Validate process config
   */
  private validateConfig(config: ProcessConfig): void {
    if (!config.name) {
      throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, 'Process name is required');
    }

    if (!config.script) {
      throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, 'Process script is required');
    }

    if (config.cronRestart !== undefined) {
      try {
        parseCron(config.cronRestart);
        if (config.cronTimezone !== undefined) assertTimeZone(config.cronTimezone);
      } catch (err) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid cronRestart for "${config.name}": ${(err as Error).message}`);
      }
    }
    const memory = config.limits?.memory?.max ?? config.maxMemory;
    if (memory !== undefined && parseBytes(memory) === undefined) {
      throw new DaemonError(
        ErrorCode.PROCESS_INVALID_CONFIG,
        `Invalid maxMemory "${String(memory)}" for "${config.name}" (use bytes or a size like 512M)`
      );
    }
    const cpu = config.limits?.cpu?.max ?? config.maxCpu;
    if (cpu !== undefined && !(typeof cpu === 'number' && cpu > 0)) {
      throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid maxCpu "${String(cpu)}" for "${config.name}" (a percentage above 0)`);
    }
    for (const kind of ['fds', 'children', 'eventLoop'] as const) {
      const limit = config.limits?.[kind];
      if (limit === undefined) continue;
      if (!(typeof limit.max === 'number' && Number.isInteger(limit.max) && limit.max > 0)) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid limits.${kind}.max "${String(limit.max)}" for "${config.name}" (a whole number above 0)`);
      }
    }
    const deploy = config.deploy;
    if (deploy) {
      if (deploy.strategy !== undefined && !(['rolling', 'blue-green', 'canary', 'recreate'] as string[]).includes(deploy.strategy)) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid deploy strategy "${deploy.strategy as string}" for "${config.name}" (rolling, blue-green, canary or recreate)`);
      }
      const positive = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
      const percent = (value: unknown): boolean => typeof value === 'number' && value > 0 && value <= 100;
      if (![deploy.maxSurge, deploy.switchTimeout, deploy.readyTimeout, deploy.timeout, deploy.canaryAnalysis?.duration].every(positive)
        || (deploy.canaryPercent !== undefined && !percent(deploy.canaryPercent))
        || (deploy.canarySteps !== undefined && !(deploy.canarySteps.length > 0 && deploy.canarySteps.every(percent)))) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid deploy settings for "${config.name}" (times and maxSurge above 0, percentages from 1 to 100)`);
      }
      const analysis = deploy.canaryAnalysis;
      if (!positive(analysis?.interval)) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid canaryAnalysis.interval for "${config.name}" (milliseconds above 0)`);
      }
      const checks: unknown = analysis?.metrics;
      if (checks !== undefined && (!Array.isArray(checks) || !checks.every((check: Record<string, unknown> | null) =>
        typeof check === 'object' && check !== null && typeof check['metric'] === 'string' && check['metric'] !== ''
        && (check['per'] === undefined || typeof check['per'] === 'string')
        && (check['max'] !== undefined || check['maxRatio'] !== undefined)
        && [check['max'], check['maxRatio']].every((v) => v === undefined || (typeof v === 'number' && v > 0))
        && (check['minSamples'] === undefined || (typeof check['minSamples'] === 'number' && check['minSamples'] >= 0))))) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid canaryAnalysis.metrics for "${config.name}" (each needs a metric name and max and/or maxRatio above 0)`);
      }
    }
    for (const action of [config.limits?.memory?.action, config.limits?.cpu?.action, config.limits?.fds?.action, config.limits?.children?.action, config.limits?.eventLoop?.action]) {
      if (action !== undefined && !(['warn', 'restart', 'stop'] as string[]).includes(action)) {
        throw new DaemonError(ErrorCode.PROCESS_INVALID_CONFIG, `Invalid limit action "${action}" for "${config.name}" (warn, restart or stop)`);
      }
    }
  }

  /**
   * Convert to ProcessInfo
   */
  private toProcessInfo(proc: ManagedProcessInfo): ProcessInfo {
    const now = new Date();
    const uptime = proc.startTime ? now.getTime() - proc.startTime.getTime() : 0;

    return {
      id: proc.id,
      name: proc.config.name,
      status: proc.status,
      mode: (proc.config.mode ?? 'fork'),
      instances: proc.config.mode === 'cluster' ? this.resolveInstances(proc.config) : 1,
      runningInstances: proc.config.mode === 'cluster' ? proc.workerPids.size : (proc.childProcess ? 1 : 0),
      pid: proc.pid,
      pids: proc.pids,
      restartCount: proc.restartCount,
      uptime,
      cpu: proc.cpu,
      memory: proc.memory,
      script: proc.config.script,
      cwd: proc.config.cwd,
      createdAt: now.toISOString(),
      startedAt: proc.startTime?.toISOString(),
      errorMessage: proc.statusReason ?? (proc.status === 'errored' ? 'Process exited with error' : undefined),
      env: {},
    };
  }

  /**
   * Cluster deploys: the worker indices currently online
   */
  getWorkerIndices(name: string): number[] {
    return [...(this.processes.get(name)?.workerPids.keys() ?? [])].sort((a, b) => a - b);
  }

  /**
   * Send a deploy step to the cluster primary and wait for its answer
   */
  private clusterStep(name: string, message: { type: string; id: string } & Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; error?: string; pid?: number }> {
    const proc = this.processes.get(name);
    const primary = proc?.childProcess;
    if (!proc || proc.config.mode !== 'cluster' || !primary?.connected) {
      return Promise.reject(new ProcessError(ErrorCode.PROCESS_INVALID_CONFIG, name, `Process "${name}" is not a running cluster`));
    }
    const waiters = proc.deployWaiters ??= new Map<string, (message: { ok: boolean; error?: string; pid?: number }) => void>();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(message.id); resolve({ ok: false, error: `no answer from the cluster primary after ${String(timeoutMs)}ms` }); }, timeoutMs);
      waiters.set(message.id, (answer) => { clearTimeout(timer); waiters.delete(message.id); resolve(answer); });
      primary.send(message);
    });
  }

  /**
   * Start a candidate worker for `index` running `release`; resolves once it is ready. The live
   * worker keeps serving until `deployCommit`.
   */
  deployPrepare(name: string, id: string, index: number, release: Release, readyTimeout = 30000): Promise<{ ok: boolean; error?: string; pid?: number }> {
    const proc = this.processes.get(name);
    const base = proc?.config;
    const spec = base ? this.releaseSpec(base, release) : {};
    return this.clusterStep(name, { type: 'od:prepare', id, index, spec, timeout: readyTimeout }, readyTimeout + 5000);
  }

  deployCommit(name: string, id: string, drain?: number): Promise<{ ok: boolean; error?: string; pid?: number }> {
    return this.clusterStep(name, { type: 'od:commit', id, ...(drain === undefined ? {} : { drain }) }, 10000);
  }

  deployAbort(name: string, id: string): Promise<{ ok: boolean; error?: string; pid?: number }> {
    return this.clusterStep(name, { type: 'od:abort', id }, 10000);
  }

  /**
   * The primary's view of a release: absolute script, arguments and the app's environment with the release's on top
   */
  private releaseSpec(config: ProcessConfig, release: Release): { script?: string; args?: string[]; env: Record<string, string>; version?: string } {
    const merged: ProcessConfig = { ...config, ...(release.env ? { env: { ...config.env, ...release.env } } : {}) };
    // Only the app's own variables: the workers inherit the rest from the primary
    const resolved = this.buildEnv(merged);
    const env = Object.fromEntries(Object.keys(merged.env ?? {}).map((key) => [key, resolved[key] ?? '']));
    return {
      ...(release.script === undefined ? {} : { script: resolve(release.script) }),
      ...(release.args === undefined ? {} : { args: release.args }),
      env,
      // Always set, so a release without a label clears the previous one
      version: release.version ?? '',
    };
  }

  /**
   * Make `release` the process's configuration: later (re)starts and crash restarts use it, and a
   * running cluster's workers fork from it. Does not restart anything.
   */
  applyRelease(name: string, release: Release, replace = false): void {
    const proc = this.processes.get(name);
    if (!proc) throw new ProcessError(ErrorCode.PROCESS_NOT_FOUND, name, `Process "${name}" not found`);
    // `replace` puts back exactly what a release changed (rollback), without leftovers
    const { args: _args, env: _env, ...rest } = proc.config;
    proc.config = replace
      ? { ...rest, script: release.script ?? proc.config.script, ...(release.args === undefined ? {} : { args: release.args }), ...(release.env === undefined ? {} : { env: release.env }) }
      : {
        ...proc.config,
        ...(release.script === undefined ? {} : { script: release.script }),
        ...(release.args === undefined ? {} : { args: release.args }),
        ...(release.env ? { env: { ...proc.config.env, ...release.env } } : {}),
      };
    const primary = proc.childProcess;
    if (proc.config.mode === 'cluster' && primary?.connected) {
      primary.send({
        type: 'od:release',
        spec: this.releaseSpec(proc.config, {
          script: proc.config.script,
          ...(proc.config.args === undefined ? {} : { args: proc.config.args }),
          ...(release.version === undefined ? {} : { version: release.version }),
        }),
      });
    }
  }

  /**
   * Get all managed processes (for WebUI and other plugins)
   */
  getProcesses(): ProcessInfo[] {
    return Array.from(this.processes.values()).map((proc) => this.toProcessInfo(proc));
  }

  /**
   * Latest SDK runtime metrics of a process, per instance (for the metrics-collector plugin)
   */
  getCustomMetrics(name: string): Array<{ instanceId?: number; metrics: MetricSnapshot[] }> {
    const proc = this.processes.get(name);
    if (!proc) return [];
    return [...proc.customMetrics].map(([key, metrics]) => (key === '' ? { metrics } : { instanceId: Number(key), metrics }));
  }

  /**
   * Configuration a process was started with (for the health-check and other plugins)
   */
  getProcessConfig(name: string): ProcessConfig | undefined {
    return this.processes.get(name)?.config;
  }

  /**
   * Start a process (for WebUI and other plugins)
   */
  async startProcessFromPlugin(config: ProcessConfig): Promise<ProcessInfo> {
    return this.startProcess(config);
  }

  /**
   * Stop a process (for WebUI and other plugins)
   */
  async stopProcessFromPlugin(name: string): Promise<void> {
    await this.stopProcess({ name });
  }

  /**
   * Restart a process (for WebUI and other plugins)
   */
  async restartProcessFromPlugin(name: string): Promise<ProcessInfo> {
    return this.restartProcess({ name });
  }

  /**
   * Delete a process (for WebUI and other plugins)
   */
  async deleteProcessFromPlugin(name: string): Promise<void> {
    return this.deleteProcess({ name });
  }
}
