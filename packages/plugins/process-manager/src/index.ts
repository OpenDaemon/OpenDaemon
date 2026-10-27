import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { Logger } from '../../../core/src/index.js';
import { DaemonError, ErrorCode, ProcessError } from '../../../core/src/index.js';
import type {
  ProcessConfig,
  ProcessInfo,
  ProcessStatus,
} from '../../../core/src/index.js';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';

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
  workers: ChildProcess[];
  stopTimeout?: NodeJS.Timeout | undefined;
  cpu: number;
  memory: number;
  metricsInterval?: NodeJS.Timeout | undefined;
  cpuSamples?: Map<number, { ticks: number; at: number }> | undefined;
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
  }

  /**
   * Start the plugin
   */
  async onStart(context: PluginContext): Promise<void> {
    this.logger.info('Process manager starting');

    // Load processes from config
    const config = context.config;
    if (config.apps) {
      for (const appConfig of config.apps) {
        try {
          await this.startProcess(appConfig);
        } catch (err) {
          this.logger.error(`Failed to start ${appConfig.name}`, undefined, err as Error);
        }
      }
    }
  }

  /**
   * Stop the plugin
   */
  async onStop(): Promise<void> {
    this.stopping = true;
    this.logger.info('Process manager stopping');

    // Stop all processes
    const promises = Array.from(this.processes.values()).map(async (proc) => {
      try {
        // Same budget as `od stop`; it must stay below the CLI's 10s wait before it SIGKILLs
        // the daemon, otherwise children that ignore SIGTERM are orphaned
        await this.stopProcessInternal(proc, 'SIGTERM', proc.config.killTimeout ?? 5000);
      } catch (err) {
        this.logger.error(`Failed to stop ${proc.config.name}`, undefined, err as Error);
      }
    });

    await Promise.all(promises);
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
    if (existing && existing.status !== 'stopped' && existing.status !== 'errored') {
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
      workers: [],
      cpu: 0,
      memory: 0,
      logs: existing?.logs ?? [],
    };

    this.processes.set(config.name, proc);

    try {
      // Start the process
      if (config.mode === 'cluster' && typeof config.instances === 'number' && config.instances > 1) {
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
    });
  }

  // Linux USER_HZ; 100 on every mainstream architecture
  private static readonly CLOCK_TICKS = 100;

  private static readonly MAX_LOG_LINES = 500;

  /**
   * Capture stdout/stderr from a child process into the log buffer
   */
  private captureOutput(proc: ManagedProcessInfo, child: ChildProcess): void {
    const addLine = (level: 'stdout' | 'stderr', data: Buffer) => {
      const lines = data.toString('utf-8').split('\n');
      for (const line of lines) {
        if (line.length === 0) continue;
        this.appendLog(proc, level, line);
      }
    };

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => { addLine('stdout', data); });
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => { addLine('stderr', data); });
    }
  }

  /**
   * Append a log entry, keeping the buffer bounded
   */
  private appendLog(proc: ManagedProcessInfo, level: 'stdout' | 'stderr', message: string): void {
    proc.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    // Trim oldest entries when buffer exceeds limit
    if (proc.logs.length > ProcessManagerPlugin.MAX_LOG_LINES) {
      proc.logs.splice(0, proc.logs.length - ProcessManagerPlugin.MAX_LOG_LINES);
    }
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

    // Handle process events
    child.on('exit', (code, signal) => {
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
   * Start process in cluster mode
   */
  private async startCluster(proc: ManagedProcessInfo): Promise<void> {
    const config = proc.config;
    const instances = typeof config.instances === 'number' ? config.instances : 1;

    proc.pids = [];

    for (let i = 0; i < instances; i++) {
      this.startWorker(proc, i);
    }

    proc.pid = proc.pids[0];

    // Same readiness rule as fork mode, waited for all workers together
    const minUptime = config.minUptime;
    if (minUptime) {
      await Promise.all(proc.workers.map((worker) => this.waitForReady(worker, minUptime)));
    }
  }

  /**
   * Start a single worker
   */
  private startWorker(proc: ManagedProcessInfo, index: number): void {
    const config = proc.config;
    const scriptPath = resolve(config.script);
    const cwd = config.cwd ? resolve(config.cwd) : dirname(scriptPath);

    const env = {
      ...this.buildEnv(config),
      OD_WORKER_ID: String(index),
      OD_WORKER_COUNT: String(config.instances),
    };

    const child = spawn(process.execPath, [scriptPath, ...(config.args ?? [])], {
      cwd,
      env,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    proc.workers[index] = child;
    if (child.pid) {
      proc.pids.push(child.pid);
    }

    // Capture worker stdout/stderr
    this.captureOutput(proc, child);

    child.on('exit', (code, signal) => {
      this.handleWorkerExit(proc, index, code, signal);
    });

    child.on('error', (err) => {
      this.logger.error(`Worker error: ${config.name}[${index}]`, undefined, err);
    });
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

    // Clear worker restart timeouts
    const workerTimeouts = (proc as ManagedProcessInfo & { workerTimeouts?: Map<number, NodeJS.Timeout> }).workerTimeouts;
    if (workerTimeouts) {
      for (const timeout of workerTimeouts.values()) {
        clearTimeout(timeout);
      }
      workerTimeouts.clear();
    }

    // `killed` only means a signal was delivered, not that the child exited,
    // so liveness is judged by exitCode/signalCode instead
    const isAlive = (child: ChildProcess | undefined): child is ChildProcess =>
      child !== undefined && child.exitCode === null && child.signalCode === null;
    const children = [proc.childProcess, ...proc.workers].filter(isAlive);

    // Send signal to main process and workers
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

    proc.status = 'stopped';
    proc.pid = undefined;
    proc.pids = [];
    proc.childProcess = undefined;
    proc.workers = [];
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
        if (proc.config.mode === 'cluster' && typeof proc.config.instances === 'number' && proc.config.instances > 1) {
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
   * Handle worker exit
   */
  private handleWorkerExit(
    proc: ManagedProcessInfo,
    index: number,
    code: number | null,
    signal: string | null
  ): void {
    if (this.stopping || proc.status === 'stopping' || proc.status === 'stopped') {
      return;
    }

    this.logger.info(`Worker exited: ${proc.config.name}[${index}]`, { code, signal });

    // Restart worker if needed
    const shouldRestart = this.shouldRestart(proc, code);

    if (shouldRestart) {
      const workerTimeouts = (proc as ManagedProcessInfo & { workerTimeouts?: Map<number, NodeJS.Timeout> }).workerTimeouts ??= new Map();

      const existingTimeout = workerTimeouts.get(index);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      workerTimeouts.set(index, setTimeout(() => {
        workerTimeouts.delete(index);
        if (proc.status === 'stopping' || proc.status === 'stopped') {
          return;
        }
        try {
          this.startWorker(proc, index);
        } catch (err) {
          this.logger.error(`Failed to restart worker: ${proc.config.name}[${index}]`, undefined, err as Error);
        }
      }, proc.config.restartDelay ?? 1000));
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

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
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
      instances: typeof proc.config.instances === 'number' ? proc.config.instances : (proc.config.instances === 'max' ? proc.workers.length || 1 : 1),
      runningInstances: proc.workers.length || (proc.childProcess ? 1 : 0),
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
      errorMessage: proc.status === 'errored' ? 'Process exited with error' : undefined,
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
