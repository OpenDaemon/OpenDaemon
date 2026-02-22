import { IpcClient } from '@opendaemon/core';
import { resolve } from 'path';
import { existsSync } from 'fs';

/**
 * CLI client for communicating with daemon
 */
export class CliClient {
  private client: IpcClient;
  private connected = false;
  private isWindows = process.platform === 'win32';

  constructor() {
    // Use TCP on Windows (Unix sockets have permission issues), Unix socket on Linux/Mac
    if (this.isWindows) {
      this.client = new IpcClient({
        host: '127.0.0.1',
        port: 9995,
        timeout: 30000,
      });
    } else {
      this.client = new IpcClient({
        socketPath: resolve('opendaemon.sock'),
        timeout: 30000,
      });
    }
  }

  /**
   * Check if daemon is running
   */
  isDaemonRunning(): boolean {
    if (this.isWindows) {
      // On Windows, try to connect to TCP port
      // We'll just try connecting and see if it works
      return true; // Assume running, connection will fail if not
    }
    return existsSync(resolve('opendaemon.sock'));
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
   * Ensure connected to daemon
   */
  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to daemon');
    }
  }
}
