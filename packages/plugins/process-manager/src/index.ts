import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { Logger } from '../../../core/src/index.js';
import { DaemonError, ErrorCode, ProcessError } from '../../../core/src/index.js';
import type {
  ProcessConfig,
  ProcessInfo,
  ProcessStatus,
  ProcessMode,
} from '../../../core/src/index.js';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * Managed process information
 */
interface ManagedProcessInfo {
  id: number;
  config: ProcessConfig;
  status: ProcessStatus;
  pid?: number;
  pids: number[];
  startTime?: Date;
  restartCount: number;
  lastRestart?: Date;
  childProcess?: ChildProcess;
  workers: ChildProcess[];
  stopTimeout?: NodeJS.Timeout;
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

  private processes = new Map<string, ManagedProcessInfo>();
  private nextId = 0;
  private context!: PluginContext;
  private logger: Logger;
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
        await this.stopProcessInternal(proc, 'SIGTERM', 10000);
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
  private async listProcesses(): Promise<ProcessInfo[]> {
    return Array.from(this.processes.values()).map((proc) => this.toProcessInfo(proc));
  }

  /**
   * Get process info by name
   */
  private async getProcessInfo(params: { name: string }): Promise<ProcessInfo | null> {
    const proc = this.processes.get(params.name);
    if (!proc) {
      return null;
    }
    return this.toProcessInfo(proc);
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
    };

    this.processes.set(config.name, proc);

    try {
      // Start the process
      if (config.mode === 'cluster' && config.instances && config.instances > 1) {
        await this.startCluster(proc);
      } else {
        await this.startFork(proc);
      }

      proc.status = 'online';
      proc.startTime = new Date();

      this.logger.info(`Process started: ${config.name}`, { pid: proc.pid });
      this.context.events.emit('process:started', { name: config.name, pid: proc.pid });

      return this.toProcessInfo(proc);
    } catch (err) {
      proc.status = 'errored';
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
      await this.startWorker(proc, i);
    }

    proc.pid = proc.pids[0];
  }

  /**
   * Start a single worker
   */
  private async startWorker(proc: ManagedProcessInfo, index: number): Promise<void> {
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

    // Clear any pending restart timeouts
    if (proc.stopTimeout) {
      clearTimeout(proc.stopTimeout);
      proc.stopTimeout = undefined;
    }

    // Send signal to main process
    if (proc.childProcess && !proc.childProcess.killed) {
      proc.childProcess.kill(signal as NodeJS.Signals);
    }

    // Send signal to workers
    for (const worker of proc.workers) {
      if (worker && !worker.killed) {
        worker.kill(signal as NodeJS.Signals);
      }
    }

    // Wait for processes to exit
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const allStopped = proc.workers.every((w) => !w || w.killed) && 
        (!proc.childProcess || proc.childProcess.killed);
      
      if (allStopped) {
        break;
      }
      
      await new Promise((r) => setTimeout(r, 100));
    }

    // Force kill if still running
    if (proc.childProcess && !proc.childProcess.killed) {
      proc.childProcess.kill('SIGKILL');
    }

    for (const worker of proc.workers) {
      if (worker && !worker.killed) {
        worker.kill('SIGKILL');
      }
    }

    proc.status = 'stopped';
    proc.pid = undefined;
    proc.pids = [];
    proc.childProcess = undefined;
    proc.workers = [];

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
    if (this.stopping) {
      return;
    }

    this.logger.info(`Process exited: ${proc.config.name}`, { code, signal });

    // Check if should restart
    const shouldRestart = this.shouldRestart(proc, code);
    
    if (shouldRestart) {
      proc.restartCount++;
      proc.lastRestart = new Date();
      proc.status = 'starting';
      
      this.logger.info(`Restarting process: ${proc.config.name}`, {
        restartCount: proc.restartCount,
      });

      setTimeout(() => {
        if (proc.config.mode === 'cluster' && proc.config.instances && proc.config.instances > 1) {
          this.startCluster(proc).catch((err) => {
            this.logger.error(`Failed to restart cluster: ${proc.config.name}`, undefined, err);
            proc.status = 'errored';
          });
        } else {
          this.startFork(proc).catch((err) => {
            this.logger.error(`Failed to restart: ${proc.config.name}`, undefined, err);
            proc.status = 'errored';
          });
        }
      }, proc.config.restartDelay ?? 1000);
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
    if (this.stopping) {
      return;
    }

    this.logger.info(`Worker exited: ${proc.config.name}[${index}]`, { code, signal });

    // Restart worker if needed
    const shouldRestart = this.shouldRestart(proc, code);
    
    if (shouldRestart) {
      setTimeout(() => {
        this.startWorker(proc, index).catch((err) => {
          this.logger.error(`Failed to restart worker: ${proc.config.name}[${index}]`, undefined, err);
        });
      }, proc.config.restartDelay ?? 1000);
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
  private async waitForReady(child: ChildProcess, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Process ready timeout'));
      }, timeout);

      child.once('message', (msg) => {
        if (msg === 'ready' || (typeof msg === 'object' && (msg as { type: string }).type === 'ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
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
        // TODO: Handle SecretReference
      }
    }

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
      mode: (proc.config.mode ?? 'fork') as ProcessMode,
      instances: proc.config.instances ?? 1,
      runningInstances: proc.workers.length || (proc.childProcess ? 1 : 0),
      pid: proc.pid,
      pids: proc.pids,
      restartCount: proc.restartCount,
      uptime,
      cpu: 0, // TODO: Implement CPU monitoring
      memory: 0, // TODO: Implement memory monitoring
      script: proc.config.script,
      cwd: proc.config.cwd,
      createdAt: now.toISOString(),
      startedAt: proc.startTime?.toISOString(),
      errorMessage: proc.status === 'errored' ? 'Process exited with error' : undefined,
      env: {}, // Don't expose env for security
    };
  }
}
