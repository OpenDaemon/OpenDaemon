import type { ParsedCommand, OptionValue } from '../parser.js';
import { term } from '../output.js';

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

    // TODO: Implement actual process listing via IPC
    const mockProcesses = [
      {
        id: 0,
        name: 'api-gateway',
        status: 'online',
        mode: 'cluster',
        instances: 4,
        cpu: 12.5,
        memory: 134217728,
        uptime: 86400000,
      },
    ];

    if (isJson) {
      console.log(JSON.stringify(mockProcesses, null, 2));
      return;
    }

    if (isQuiet) {
      for (const proc of mockProcesses) {
        console.log(proc.name);
      }
      return;
    }

    if (mockProcesses.length === 0) {
      term.info('No processes running');
      return;
    }

    const headers = ['ID', 'Name', 'Mode', 'Status', 'CPU', 'Memory', 'Uptime'];
    const rows = mockProcesses.map(proc => [
      String(proc.id),
      proc.name,
      proc.mode,
      this.formatStatus(proc.status),
      `${proc.cpu.toFixed(1)}%`,
      this.formatBytes(proc.memory),
      this.formatDuration(proc.uptime),
    ]);

    console.log(term.table(headers, rows));
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
      default:
        return status;
    }
  }

  private formatBytes(bytes: number): string {
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
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d`;
    }
    if (hours > 0) {
      return `${hours}h`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
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
    {
      name: 'name',
      alias: 'n',
      type: 'string' as const,
      description: 'Process name',
    },
    {
      name: 'instances',
      alias: 'i',
      type: 'number' as const,
      description: 'Number of instances',
      default: 1,
    },
    {
      name: 'max-memory',
      type: 'string' as const,
      description: 'Max memory (e.g., 512M, 1G)',
    },
    {
      name: 'env',
      type: 'array' as const,
      description: 'Environment variables (KEY=value)',
    },
    {
      name: 'json',
      type: 'boolean' as const,
      description: 'Output as JSON',
    },
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
    const name = (options['name'] as string) || target.replace(/\.(js|ts)$/, '');
    const instances = (options['instances'] as number) || 1;

    const spinner = term.spinner(`Starting ${name}...`);
    spinner.start();

    // TODO: Implement actual process start via IPC
    await new Promise(resolve => setTimeout(resolve, 1000));

    spinner.stop(true, `Started ${name} with ${instances} instance(s)`);
  }
}

/**
 * Stop command - stop a process
 */
export class StopCommand implements Command {
  name = 'stop';
  description = 'Stop process(es)';
  options = [
    {
      name: 'json',
      type: 'boolean' as const,
      description: 'Output as JSON',
    },
  ];

  async execute(
    args: string[],
    _options: Record<string, OptionValue | undefined>
  ): Promise<void> {
    if (args.length === 0) {
      term.error('No process name specified');
      process.exit(1);
    }

    const name = args[0];
    const spinner = term.spinner(`Stopping ${name}...`);
    spinner.start();

    // TODO: Implement actual process stop via IPC
    await new Promise(resolve => setTimeout(resolve, 500));

    spinner.stop(true, `Stopped ${name}`);
  }
}

/**
 * Status command - show daemon status
 */
export class StatusCommand implements Command {
  name = 'status';
  description = 'Show daemon status';

  async execute(): Promise<void> {
    // TODO: Implement actual status check via IPC
    term.info('Daemon status: not implemented');
  }
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
      case 'start':
        await this.startDaemon();
        break;
      case 'stop':
        await this.stopDaemon();
        break;
      case 'restart':
        await this.restartDaemon();
        break;
      case 'status':
        await this.daemonStatus();
        break;
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
    const spinner = term.spinner('Starting daemon...');
    spinner.start();

    // TODO: Implement actual daemon start
    await new Promise(resolve => setTimeout(resolve, 1000));

    spinner.stop(true, 'Daemon started');
  }

  private async stopDaemon(): Promise<void> {
    const spinner = term.spinner('Stopping daemon...');
    spinner.start();

    // TODO: Implement actual daemon stop
    await new Promise(resolve => setTimeout(resolve, 1000));

    spinner.stop(true, 'Daemon stopped');
  }

  private async restartDaemon(): Promise<void> {
    await this.stopDaemon();
    await this.startDaemon();
  }

  private async daemonStatus(): Promise<void> {
    // TODO: Implement actual daemon status
    term.info('Daemon: not running');
  }
}
