import { IpcClient } from '@opendaemon/core';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Token the daemon wrote for this session; unreadable (another user's daemon) means no access
 */
function readAuthToken(): string | undefined {
  try {
    const file = resolve('opendaemon.token');
    return existsSync(file) ? readFileSync(file, 'utf-8').trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * CLI client for communicating with daemon
 */
export class CliClient {
  private readonly client: IpcClient;
  private connected = false;
  private readonly isWindows = process.platform === 'win32';

  constructor() {
    const authToken = readAuthToken();
    const auth = authToken === undefined ? {} : { authToken };
    // Use TCP on Windows (Unix sockets have permission issues), Unix socket on Linux/Mac
    if (this.isWindows) {
      this.client = new IpcClient({
        host: '127.0.0.1',
        port: 9995,
        timeout: 30000,
        ...auth,
      });
    } else {
      this.client = new IpcClient({
        socketPath: resolve('opendaemon.sock'),
        timeout: 30000,
        ...auth,
      });
    }
  }

  /**
   * Check if daemon is running
   */
  isDaemonRunning(): boolean {
    // Windows talks TCP, so there is no socket file; the daemon writes its PID file on every
    // platform and removes it on shutdown, which gives the same signal
    return existsSync(resolve(this.isWindows ? 'opendaemon.pid' : 'opendaemon.sock'));
  }

  /**
   * Connect to daemon
   */
  async connect(): Promise<void> {
    if (!this.isDaemonRunning()) {
      throw new Error('Daemon is not running');
    }

    await this.client.connect();
    this.connected = true;
  }

  /**
   * Disconnect from daemon
   */
  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.connected = false;
  }

  /**
   * List all processes
   */
  async listProcesses(): Promise<unknown[]> {
    this.ensureConnected();
    return this.client.call('list') as Promise<unknown[]>;
  }

  /**
   * Start a process
   */
  async startProcess(config: unknown): Promise<unknown> {
    this.ensureConnected();
    return this.client.call('start', config);
  }

  /**
   * Stop a process
   */
  async stopProcess(name: string, signal?: string, timeout?: number): Promise<void> {
    this.ensureConnected();
    await this.client.call('stop', { name, signal, timeout });
  }

  /**
   * Restart a process
   */
  async restartProcess(name: string): Promise<unknown> {
    this.ensureConnected();
    return this.client.call('restart', { name });
  }

  /**
   * Delete a process
   */
  async deleteProcess(name: string): Promise<void> {
    this.ensureConnected();
    await this.client.call('delete', { name });
  }

  /**
   * Get daemon status
   */
  async getDaemonStatus(): Promise<unknown> {
    this.ensureConnected();
    return this.client.call('daemon.status');
  }

  /**
   * Shutdown daemon
   */
  async shutdownDaemon(): Promise<void> {
    this.ensureConnected();
    await this.client.call('daemon.shutdown');
  }

  /**
   * Get detailed info for a single process
   */
  async getProcessInfo(name: string): Promise<unknown> {
    this.ensureConnected();
    return this.client.call('info', { name });
  }

  /**
   * Get logs for a process
   */
  async getLogs(name: string, lines?: number): Promise<unknown> {
    this.ensureConnected();
    return this.client.call('logs', { name, lines: lines ?? 100 });
  }

  /**
   * Get health check status for all monitored processes, or one by name
   */
  async getHealth(name?: string): Promise<unknown> {
    this.ensureConnected();
    return this.client.call('health', name === undefined ? {} : { name });
  }

  /**
   * Ensure connected to daemon
   */
  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to daemon');
    }
  }
}
