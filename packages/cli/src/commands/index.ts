import type { OptionValue } from '../parser.js';
import { term } from '../output.js';
import { CliClient } from '../client.js';
import { resolve } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';

/**
 * Command handler interface
 */
export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  options?: Array<{
    name: string;
    alias?: string;
    type: 'string' | 'number' | 'boolean' | 'array';
    description: string;
    default?: OptionValue;
  }>;
  execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void>;
}

/**
 * List command - list all processes
 */
export class ListCommand implements Command {
  name = 'list';
  aliases = ['ls'];
  description = 'List all processes';
  options = [
    {
      name: 'json',
      type: 'boolean' as const,
      description: 'Output as JSON',
    },
    {
      name: 'quiet',
      alias: 'q',
      type: 'boolean' as const,
      description: 'Show only process names',
    },
  ];

  async execute(
    _args: string[],
    options: Record<string, OptionValue | undefined>
  ): Promise<void> {
    const isJson = options['json'] === true;
    const isQuiet = options['quiet'] === true;

    try {
      const client = new CliClient();
      await client.connect();

      const processes = await client.listProcesses();
      await client.disconnect();

      if (isJson) {
        console.log(JSON.stringify(processes, null, 2));
        return;
      }

      if (isQuiet) {
        for (const proc of processes) {
          const p = proc as { name: string };
          console.log(p.name);
        }
        return;
      }

      if (processes.length === 0) {
        term.info('No processes running');
        return;
      }

      const headers = ['ID', 'Name', 'Mode', 'Status', 'CPU', 'Memory', 'Restarts', 'Uptime'];
      const rows = processes.map((proc: unknown) => {
        const p = proc as {
          id: number;
          name: string;
          mode: string;
          status: string;
          cpu: number;
          memory: number;
          restartCount: number;
          uptime: number;
        };
        return [
          String(p.id),
          p.name,
          p.mode,
          this.formatStatus(p.status),
          `${p.cpu.toFixed(1)}%`,
          this.formatBytes(p.memory),
          String(p.restartCount),
          this.formatDuration(p.uptime),
        ];
      });

      console.log(term.table(headers, rows));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      term.error(`Failed to list processes: ${error.message}`);
      process.exit(1);
    }
  }

  private formatStatus(status: string): string {
    switch (status) {
      case 'online':
        return term.color('green', '● online');
      case 'stopped':
        return term.color('gray', '○ stopped');
      case 'errored':
        return term.color('red', '✗ errored');
      case 'starting':
        return term.color('yellow', '◌ starting');
      case 'stopping':
        return term.color('yellow', '◌ stopping');
      default:
        return status;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0B';
    const units = ['B', 'K', 'M', 'G', 'T'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(1)}${units[unitIndex]}`;
  }

  private formatDuration(ms: number): string {
    if (ms === 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

/**
 * Start command - start a process
 */
export class StartCommand implements Command {
  name = 'start';
  description = 'Start a process or processes from config';
  options = [
    { name: 'name', alias: 'n', type: 'string' as const, description: 'Process name' },
    { name: 'instances', alias: 'i', type: 'number' as const, description: 'Number of instances', default: 1 },
    { name: 'max-memory', type: 'string' as const, description: 'Max memory (e.g., 512M, 1G)' },
    { name: 'env', type: 'array' as const, description: 'Environment variables (KEY=value)' },
    { name: 'json', type: 'boolean' as const, description: 'Output as JSON' },
  ];

  async execute(
    args: string[],
    options: Record<string, OptionValue | undefined>
  ): Promise<void> {
    if (args.length === 0) {
      term.error('No script or config file specified');
      process.exit(1);
    }

    const target = args[0] || '';
    const name = (options['name'] as string) || target.replace(/\.(js|ts|mjs|cjs)$/, '').replace(/[/\\]/g, '-');
    const instances = (options['instances'] as number) || 1;

    const scriptPath = resolve(target);
    if (!existsSync(scriptPath)) {
      term.error(`Script not found: ${target}`);
      process.exit(1);
    }

    const spinner = term.spinner(`Starting ${name}...`);
    spinner.start();

    try {
      const client = new CliClient();
      await client.connect();

      const processConfig = {
        name,
        script: scriptPath,
        instances,
        mode: instances > 1 ? 'cluster' : 'fork',
        cwd: process.cwd(),
      };

      await client.startProcess(processConfig);
      await client.disconnect();

      spinner.stop(true, `Started ${name} with ${instances} instance(s)`);
    } catch (err) {
      spinner.stop(false);
      const error = err instanceof Error ? err : new Error(String(err));
      term.error(`Failed to start process: ${error.message}`);
      process.exit(1);
    }
  }
}

/**
 * Stop command - stop a process
 */
export class StopCommand implements Command {
  name = 'stop';
  description = 'Stop process(es)';
  options = [{ name: 'json', type: 'boolean' as const, description: 'Output as JSON' }];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    if (args.length === 0) { term.error('No process name specified'); process.exit(1); }

    const name = args[0];
    const spinner = term.spinner(`Stopping ${name}...`);
    spinner.start();

    try {
      const client = new CliClient();
      await client.connect();
      await client.stopProcess(name);
      await client.disconnect();
      spinner.stop(true, `Stopped ${name}`);
    } catch (err) {
      spinner.stop(false);
      term.error(`Failed to stop process: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Restart command - restart a process
 */
export class RestartCommand implements Command {
  name = 'restart';
  description = 'Restart process(es)';
  options = [];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    if (args.length === 0) { term.error('No process name specified'); process.exit(1); }

    const name = args[0];
    const spinner = term.spinner(`Restarting ${name}...`);
    spinner.start();

    try {
      const client = new CliClient();
      await client.connect();
      await client.restartProcess(name);
      await client.disconnect();
      spinner.stop(true, `Restarted ${name}`);
    } catch (err) {
      spinner.stop(false);
      term.error(`Failed to restart process: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Delete command - delete a process
 */
export class DeleteCommand implements Command {
  name = 'delete';
  description = 'Delete a process';
  options = [{ name: 'json', type: 'boolean' as const, description: 'Output as JSON' }];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    if (args.length === 0) { term.error('No process name specified'); process.exit(1); }

    const name = args[0];
    const spinner = term.spinner(`Deleting ${name}...`);
    spinner.start();

    try {
      const client = new CliClient();
      await client.connect();
      await client.deleteProcess(name);
      await client.disconnect();
      spinner.stop(true, `Deleted ${name}`);
    } catch (err) {
      spinner.stop(false);
      term.error(`Failed to delete process: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Info command - show detailed process information
 */
export class InfoCommand implements Command {
  name = 'info';
  description = 'Show detailed process information';
  options = [];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    if (args.length === 0) { term.error('No process name specified'); process.exit(1); }

    try {
      const client = new CliClient();
      await client.connect();
      const info = await client.getProcessInfo(args[0]) as {
        id: number; name: string; status: string; mode: string; pid: number;
        instances: number; runningInstances: number; cpu: number; memory: number;
        restartCount: number; uptime: number; script: string; cwd: string; startedAt: string;
      } | null;
      await client.disconnect();

      if (!info) { term.error(`Process "${args[0]}" not found`); process.exit(1); }

      console.log(`\n${term.bold(info.name)}`);
      console.log(term.keyValue('  Status', info.status));
      console.log(term.keyValue('  Mode', info.mode));
      console.log(term.keyValue('  PID', String(info.pid || 'N/A')));
      console.log(term.keyValue('  Instances', `${info.runningInstances}/${info.instances}`));
      console.log(term.keyValue('  CPU', `${info.cpu.toFixed(1)}%`));
      console.log(term.keyValue('  Memory', formatBytes(info.memory)));
      console.log(term.keyValue('  Restarts', String(info.restartCount)));
      console.log(term.keyValue('  Uptime', formatDuration(info.uptime)));
      console.log(term.keyValue('  Script', info.script));
      console.log(term.keyValue('  CWD', info.cwd || 'N/A'));
      console.log(term.keyValue('  Started', info.startedAt || 'N/A'));
      console.log('');
    } catch (err) {
      term.error(`Failed to get info: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Logs command - view process logs
 */
export class LogsCommand implements Command {
  name = 'logs';
  description = 'View process logs';
  options = [];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    if (args.length === 0) { term.error('No process name specified'); process.exit(1); }

    try {
      const client = new CliClient();
      await client.connect();
      const logs = await client.getLogs(args[0]);
      await client.disconnect();

      if (Array.isArray(logs) && logs.length === 0) {
        term.info(`No logs available for "${args[0]}"`);
        return;
      }

      if (Array.isArray(logs)) {
        for (const entry of logs) {
          const e = entry as { timestamp: string; level: string; message: string };
          console.log(`${term.dim(e.timestamp)} [${e.level}] ${e.message}`);
        }
      } else {
        console.log(String(logs));
      }
    } catch (err) {
      term.error(`Failed to get logs: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Status command - show daemon status
 */
export class StatusCommand implements Command {
  name = 'status';
  description = 'Show daemon status';

  async execute(): Promise<void> {
    try {
      const client = new CliClient();
      if (!client.isDaemonRunning()) { term.info('Daemon: not running'); return; }

      await client.connect();
      const status = await client.getDaemonStatus() as { status: string; pid: number; uptime: number };
      const processes = await client.listProcesses() as { status: string }[];
      await client.disconnect();

      const online = processes.filter(p => p.status === 'online').length;
      const errored = processes.filter(p => p.status === 'errored').length;
      const stopped = processes.filter(p => p.status === 'stopped').length;

      console.log(`\n${term.bold('OpenDaemon Status')}`);
      console.log(term.keyValue('  Daemon', `${term.color('green', '● running')} (PID: ${status.pid})`));
      console.log(term.keyValue('  Uptime', formatDuration(status.uptime * 1000)));
      console.log(term.keyValue('  Processes', `${processes.length} total (${online} online, ${errored} errored, ${stopped} stopped)`));
      console.log('');
    } catch (err) {
      term.error(`Failed to get status: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

// Shared helpers
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex++; }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const PID_FILE = 'opendaemon.pid';
const SOCKET_FILE = 'opendaemon.sock';

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getDaemonScriptPath(): string {
  const currentDir = resolve(process.cwd(), 'packages', 'cli');
  const distPath = resolve(currentDir, 'dist', 'daemon.js');
  const srcPath = resolve(currentDir, 'src', 'daemon.ts');
  if (existsSync(distPath)) return distPath;
  return srcPath;
}

/**
 * Daemon command - manage daemon
 */
export class DaemonCommand implements Command {
  name = 'daemon';
  description = 'Manage daemon';

  async execute(args: string[]): Promise<void> {
    const subcommand = args[0];
    switch (subcommand) {
      case 'start': await this.startDaemon(); break;
      case 'stop': await this.stopDaemon(); break;
      case 'restart': await this.restartDaemon(); break;
      case 'status': await this.daemonStatus(); break;
      default:
        term.error(`Unknown daemon subcommand: ${subcommand}`);
        console.log('\nAvailable subcommands:');
        console.log('  start    Start the daemon');
        console.log('  stop     Stop the daemon');
        console.log('  restart  Restart the daemon');
        console.log('  status   Show daemon status');
        process.exit(1);
    }
  }

  private async startDaemon(): Promise<void> {
    const pidFile = resolve(PID_FILE);
    const socketFile = resolve(SOCKET_FILE);

    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
      if (isProcessRunning(pid)) { term.info(`Daemon is already running (PID: ${pid})`); return; }
      unlinkSync(pidFile);
    }

    const spinner = term.spinner('Starting daemon...');
    spinner.start();

    try {
      if (existsSync(socketFile)) unlinkSync(socketFile);
      const daemonScript = getDaemonScriptPath();
      if (!existsSync(daemonScript)) throw new Error(`Daemon script not found: ${daemonScript}`);

      const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: 'ignore' });

      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;
        const checkStarted = () => {
          attempts++;
          if (existsSync(pidFile)) {
            const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
            if (isProcessRunning(pid)) { resolve(); return; }
          }
          if (child.exitCode !== null && child.exitCode !== 0) { reject(new Error(`Daemon exited with code ${child.exitCode}`)); return; }
          if (attempts >= maxAttempts) { reject(new Error('Daemon failed to start within timeout')); return; }
          setTimeout(checkStarted, 100);
        };
        setTimeout(checkStarted, 100);
      });

      child.unref();
      spinner.stop(true, 'Daemon started');
    } catch (err) {
      spinner.stop(false);
      term.error(`Failed to start daemon: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }

  private async stopDaemon(): Promise<void> {
    const pidFile = resolve(PID_FILE);
    const socketFile = resolve(SOCKET_FILE);

    if (!existsSync(pidFile)) { term.info('Daemon is not running'); return; }
    const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
    if (!isProcessRunning(pid)) {
      unlinkSync(pidFile);
      if (existsSync(socketFile)) unlinkSync(socketFile);
      term.info('Daemon is not running (cleaned up stale files)');
      return;
    }

    const spinner = term.spinner('Stopping daemon...');
    spinner.start();

    try {
      process.kill(pid, 'SIGTERM');
      await new Promise<void>((resolve) => {
        let attempts = 0;
        const checkStopped = () => {
          attempts++;
          if (!isProcessRunning(pid)) { resolve(); return; }
          if (attempts >= 100) { try { process.kill(pid, 'SIGKILL'); } catch {} resolve(); return; }
          setTimeout(checkStopped, 100);
        };
        setTimeout(checkStopped, 100);
      });

      if (existsSync(pidFile)) unlinkSync(pidFile);
      if (existsSync(socketFile)) unlinkSync(socketFile);
      spinner.stop(true, 'Daemon stopped');
    } catch (err) {
      spinner.stop(false);
      term.error(`Failed to stop daemon: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }

  private async restartDaemon(): Promise<void> {
    await this.stopDaemon();
    await new Promise(resolve => setTimeout(resolve, 500));
    await this.startDaemon();
  }

  private async daemonStatus(): Promise<void> {
    const pidFile = resolve(PID_FILE);
    if (!existsSync(pidFile)) { term.info('Daemon is not running'); return; }
    const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
    if (!isProcessRunning(pid)) { term.info('Daemon is not running (stale PID file)'); return; }

    term.info(`Daemon is running (PID: ${pid})`);
    try {
      const client = new CliClient();
      await client.connect();
      const status = await client.getDaemonStatus() as { status: string; pid: number; uptime: number };
      await client.disconnect();
      console.log(`  Status: ${status.status}`);
      console.log(`  Uptime: ${Math.floor(status.uptime)}s`);
    } catch { /* IPC not available */ }
  }
}
