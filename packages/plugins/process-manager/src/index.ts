import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { Logger, parseBytes, dependencyLevels } from '../../../core/src/index.js';
import { DaemonError, ErrorCode, ProcessError } from '../../../core/src/index.js';
import type {
  ProcessConfig,
  ProcessInfo,
  ProcessStatus,
  ProcessLogEntry,
  MetricSnapshot,
} from '../../../core/src/index.js';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { availableParallelism } from 'os';
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

interface ManagedProcessInfo {
  id: number;
  config: ProcessConfig;
  status: ProcessStatus;
  pid?: number | undefined;
  pids: number[];
  startTime?: Date;
  restartCount: number;
  lastRestart?: Date;
  childProcess?: ChildProcess | undefined;
  /** Cluster mode: worker index -> pid, as reported by the cluster primary */
  workerPids: Map<number, number>;
  /** Latest SDK runtime metrics per instance ('' in fork mode, the worker index in cluster mode) */
  customMetrics: Map<string, MetricSnapshot[]>;
  stopTimeout?: NodeJS.Timeout | undefined;
  cpu: number;
  memory: number;
  metricsInterval?: NodeJS.Timeout | undefined;
  cpuSamples?: Map<number, { ticks: number; at: number }> | undefined;
  /** A maxMemory restart is in progress (metrics keep arriving meanwhile) */
  /** Why the process is waiting or errored without having run (shown in od info) */
  statusReason?: string | undefined;
  memoryRestarting?: boolean;
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
  /** Dependency levels of the configured apps (level 0 has no dependencies) */
  private startLevels: string[][] = [];

  constructor() {
    this.logger = new Logger('process-manager');
  }

  /**
   * Install the plugin
   */
  install(context: PluginContext): void {
    this.context = context;
    this.logger.info('Process manager installed');

    // Register RPC methods
    context.registerMethod('list', this.listProcesses.bind(this));
    context.registerMethod('start', this.startProcess.bind(this));
    context.registerMethod('stop', this.stopProcess.bind(this));
    context.registerMethod('restart', this.restartProcess.bind(this));
    context.registerMethod('delete', this.deleteProcess.bind(this));
    context.registerMethod('info', this.getProcessInfo.bind(this));
    context.registerMethod('logs', this.getProcessLogs.bind(this));
    context.registerMethod('scale', this.scaleProcess.bind(this));
  }

  /**
   * Start the plugin
   */
  async onStart(context: PluginContext): Promise<void> {
    this.logger.info('Process manager starting');

    // Load processes from config. Independent apps start in parallel and are awaited; an app
    // with `dependencies` starts once they are ready, in the background, so the daemon (and its
    // IPC) comes up without waiting for health checks.
    const apps = context.config.apps ?? [];
    let levels: string[][];
    try {
      levels = dependencyLevels(apps);
    } catch (err) {
      this.logger.error(`Not starting apps: ${(err as Error).message}`);
      return;
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

    // Resolve script path
    const scriptPath = resolve(config.script);
    if (!existsSync(scriptPath)) {
      throw new ProcessError(
        ErrorCode.PROCESS_INVALID_CONFIG,
        config.name,
        `Script not found: ${config.script}`
      );
    }

    // Create process info
    const proc: ManagedProcessInfo = {
      id: existing?.id ?? this.nextId++,
      config,
      status: 'starting',
      pids: [],
      restartCount: existing?.restartCount ?? 0,
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
  private async stopProcess(params: { name: string; signal?: string; timeout?: number }): Promise<void> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      throw new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`);
    }

    await this.stopProcessInternal(
      proc,
      params.signal ?? 'SIGTERM',
      params.timeout ?? (proc.config.killTimeout ?? 5000)
    );
  }

  /**
   * Restart a process
   */
  private async restartProcess(params: { name: string }): Promise<ProcessInfo> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      throw new ProcessError(ErrorCode.PROCESS_NOT_FOUND, params.name, `Process "${params.name}" not found`);
    }

    await this.stopProcessInternal(proc, 'SIGTERM', proc.config.killTimeout ?? 5000);
    return this.startProcess(proc.config);
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
    this.enforceMemoryLimit(proc);
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
      this.enforceMemoryLimit(proc);
    });
  }

  /**
   * maxMemory: restart a process whose resident memory (all instances together) exceeds the limit
   */
  private enforceMemoryLimit(proc: ManagedProcessInfo): void {
    const limit = proc.config.maxMemory === undefined ? undefined : parseBytes(proc.config.maxMemory);
    if (limit === undefined || proc.status !== 'online' || proc.memory <= limit || proc.memoryRestarting) {
      return;
    }
    proc.memoryRestarting = true;
    const name = proc.config.name;
    this.logger.warn(`Process "${name}" uses ${String(proc.memory)} bytes, over maxMemory (${String(limit)}); restarting`);
    this.context.events.emit('process:memory-limit', { name, memory: proc.memory, limit });
    proc.restartCount++;
    proc.lastRestart = new Date();
    this.restartProcess({ name }).catch((err: unknown) => {
      this.logger.error(`Memory-limit restart failed: ${name}`, undefined, err as Error);
    });
  }

  // Linux USER_HZ; 100 on every mainstream architecture
  private static readonly CLOCK_TICKS = 100;

  private static readonly MAX_LOG_LINES = 500;

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
    const scriptPath = resolve(config.script);
    const cwd = config.cwd ? resolve(config.cwd) : dirname(scriptPath);

    const env = this.buildEnv(config);

    const child = spawn(process.execPath, [scriptPath, ...(config.args ?? [])], {
      cwd,
      env,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    proc.childProcess = child;
    proc.pid = child.pid;
    if (child.pid) {
      proc.pids = [child.pid];
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
      if (proc.childProcess === child) proc.customMetrics.clear();
      this.handleProcessExit(proc, code, signal);
    });

    child.on('error', (err) => {
      this.logger.error(`Process error: ${config.name}`, undefined, err);
      proc.status = 'errored';
      this.context.events.emit('process:error', { name: config.name, error: err.message });
    });

    // Wait for process to be ready (optional)
    if (config.minUptime) {
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
      }),
    };

    const child = spawn(process.execPath, [clusterPrimaryPath()], {
      cwd,
      env,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    proc.childProcess = child;
    proc.pid = child.pid;
    proc.pids = child.pid ? [child.pid] : [];
    proc.workerPids = new Map();

    // The primary's own output (startup errors); worker output arrives as od:log messages
    this.captureOutput(proc, child);

    child.on('message', (message: unknown) => {
      this.handleClusterMessage(proc, child, message);
    });
    child.on('exit', (code, signal) => {
      if (proc.childProcess === child) {
        proc.workerPids.clear();
        proc.customMetrics.clear();
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

    // Send signal to the process (in cluster mode the primary forwards it to its workers)
    for (const child of children) {
      child.kill(signal as NodeJS.Signals);
    }

    // Wait for processes to exit
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!children.some(isAlive)) {
        break;
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    // Force kill if still running
    for (const child of children) {
      if (isAlive(child)) {
        child.kill('SIGKILL');
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

    // Stop metrics collection
    this.stopMetricsCollection(proc);

    // Check if should restart
    const shouldRestart = this.shouldRestart(proc, code);

    if (shouldRestart) {
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
        return Math.min(baseDelay * proc.restartCount, maxDelay);
      case 'exponential': {
        const delay = baseDelay * Math.pow(multiplier, proc.restartCount - 1);
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

    // Check max restarts
    const maxRestarts = proc.config.maxRestarts ?? 10;
    if (proc.restartCount >= maxRestarts) {
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

    if (config.maxMemory !== undefined && parseBytes(config.maxMemory) === undefined) {
      throw new DaemonError(
        ErrorCode.PROCESS_INVALID_CONFIG,
        `Invalid maxMemory "${String(config.maxMemory)}" for "${config.name}" (use bytes or a size like 512M)`
      );
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
    return this.stopProcess({ name });
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
