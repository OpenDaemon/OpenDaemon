import type { ProcessConfig, ProcessInfo } from '../../core/src/index.js';
import { CliClient } from './client.js';

/**
 * Programmatic control of a running daemon, like PM2's `require('pm2')`:
 *
 *   import { OpenDaemon } from 'opendaemon/client';
 *   const od = await OpenDaemon.connect();
 *   await od.start({ name: 'api', script: './server.js', instances: 2, mode: 'cluster' });
 *   console.log(await od.list());
 *   await od.disconnect();
 *
 * The daemon has to be running (`od daemon start`, or any `od` command starts it). It talks to the
 * same socket as the CLI, with the same token, so it works for the user who owns the daemon.
 */
export class OpenDaemon {
  private constructor(private readonly client: CliClient) {}

  /** Connect to the daemon of this user (or of $OPENDAEMON_HOME) */
  static async connect(): Promise<OpenDaemon> {
    const client = new CliClient();
    try {
      await client.connect();
    } catch (err) {
      throw new Error(`Cannot reach the OpenDaemon daemon: ${(err as Error).message}. Start it with "od daemon start".`);
    }
    return new OpenDaemon(client);
  }

  /** Call any daemon method (the typed methods below are shortcuts for the common ones) */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.call(method, params) as Promise<T>;
  }

  list(): Promise<ProcessInfo[]> { return this.call('list'); }

  /** One process by name, or null */
  describe(name: string): Promise<ProcessInfo | null> { return this.call('info', { name }); }

  /** Start a process; rejects when the name is taken. A `cron` app is scheduled instead of run. */
  start(config: ProcessConfig): Promise<ProcessInfo> { return this.call('start', config); }

  /** Start it, or replace the running app of that name with this config (pm2 startOrRestart) */
  startOrRestart(config: ProcessConfig): Promise<ProcessInfo> { return this.call('replace', config); }

  /** Names that were stopped (with `cascade`, the apps that depend on it first) */
  stop(name: string, options: { signal?: string; timeout?: number; cascade?: boolean } = {}): Promise<string[]> {
    return this.call('stop', { name, ...options });
  }

  /** `env` is merged into the app's environment for this and later runs */
  restart(name: string, options: { cascade?: boolean; env?: Record<string, string> } = {}): Promise<ProcessInfo> {
    return this.call('restart', { name, ...options });
  }

  delete(name: string): Promise<void> { return this.call('delete', { name }); }

  /** Change the number of cluster workers without a restart */
  scale(name: string, instances: number | 'max'): Promise<ProcessInfo> { return this.call('scale', { name, instances }); }

  /**
   * Replace a cluster app's workers one by one without downtime (rolling), optionally with a new
   * release; resolves with the final deploy state, rejects when it was rolled back or failed
   */
  async reload(name: string, release: { script?: string; args?: string[]; env?: Record<string, string>; version?: string } = {}): Promise<{ state: string; steps: string[] }> {
    await this.call('deploy.execute', { name, strategy: 'rolling', release });
    for (;;) {
      const state = await this.call<{ state: string; steps: string[]; error?: string } | null>('deploy.status', { name });
      if (state === null) throw new Error(`No deploy of "${name}"`);
      if (state.state === 'running') { await new Promise((r) => setTimeout(r, 200)); continue; }
      if (state.state !== 'succeeded') throw new Error(`Reload of ${name} ${state.state}: ${state.error ?? 'unknown error'}`);
      return state;
    }
  }

  /** Remember the process list for the next daemon start (pm2 save) */
  save(): Promise<{ file: string; saved: string[] }> { return this.call('save'); }

  resurrect(): Promise<{ started: string[]; skipped: string[]; failed: string[] }> { return this.call('resurrect'); }

  /** Zero the restart counter of one process, or of all */
  reset(name?: string): Promise<string[]> { return this.call('reset', name === undefined ? {} : { name }); }

  /** Send a signal to a running process; resolves with the pids that got it */
  signal(name: string, signal: string): Promise<number[]> { return this.call('signal', { name, signal }); }

  /** The environment an app is configured with (secrets by reference) */
  env(name: string): Promise<Record<string, string>> { return this.call('env', { name }); }

  /** Persisted log entries, oldest first */
  logs(query: { name?: string; lines?: number; grep?: string; since?: number; source?: 'stdout' | 'stderr' } = {}): Promise<LogEntry[]> {
    return this.call('logs.query', query);
  }

  /** Call `onEntry` for every new matching log entry until `disconnect()` */
  async follow(query: { name?: string; grep?: string; source?: 'stdout' | 'stderr' } = {}, onEntry: (entry: LogEntry) => void): Promise<void> {
    await this.client.followLogs(query, (entry) => { onEntry(entry as LogEntry); });
  }

  /** Daemon state, pid and uptime */
  status(): Promise<{ status: string; pid: number; uptime: number }> { return this.call('daemon.status'); }

  /** Prometheus text, or the JSON report */
  metrics(format: 'json' | 'prometheus' = 'json'): Promise<unknown> { return this.client.getMetrics(format); }

  disconnect(): Promise<void> { return this.client.disconnect(); }
}

export interface LogEntry {
  timestamp: string;
  processName: string;
  instanceId?: number;
  source: 'stdout' | 'stderr';
  message: string;
  pid: number;
}

export type { ProcessConfig, ProcessInfo };
