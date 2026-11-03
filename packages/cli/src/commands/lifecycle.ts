import type { OptionValue } from '../parser.js';
import type { Command } from './index.js';
import { ensureDaemonRunning, DeployCommand, RestartCommand } from './index.js';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { term } from '../output.js';
import { CliClient } from '../client.js';

/**
 * Run `body` against the daemon, with the connection closed afterwards and any failure reported
 */
async function withDaemon(what: string, body: (client: CliClient) => Promise<void>, startDaemon = false): Promise<void> {
  if (startDaemon) await ensureDaemonRunning();
  const client = new CliClient();
  try {
    await client.connect();
    await body(client);
  } catch (err) {
    term.error(`${what}: ${(err instanceof Error ? err : new Error(String(err))).message}`);
    process.exit(1);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

const jsonOption = { name: 'json', type: 'boolean' as const, description: 'Output as JSON' };

/**
 * save - remember the process list, so the daemon brings it back after a reboot (pm2 save)
 */
export class SaveCommand implements Command {
  name = 'save';
  description = 'Save the process list; the daemon restores it when it starts';
  options = [jsonOption];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    await withDaemon('Failed to save', async (client) => {
      const result = await client.call('save') as { file: string; saved: string[] };
      if (options['json'] === true) { console.log(JSON.stringify(result)); return; }
      term.success(`Saved ${result.saved.length} process(es) to ${result.file}`);
    });
  }
}

/**
 * resurrect - start the saved processes that are not running (pm2 resurrect)
 */
export class ResurrectCommand implements Command {
  name = 'resurrect';
  description = 'Start the processes saved with `od save`';
  options = [jsonOption];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    await withDaemon('Failed to resurrect', async (client) => {
      const result = await client.call('resurrect') as { started: string[]; skipped: string[]; failed: string[] };
      if (options['json'] === true) { console.log(JSON.stringify(result)); return; }
      term.success(`Started ${result.started.length}, left as they were ${result.skipped.length}`);
      if (result.failed.length > 0) {
        term.error(`Could not start: ${result.failed.join(', ')} (see \`od list\` and \`od logs\`)`);
        process.exit(1);
      }
    }, true);
  }
}

/**
 * reset - zero the restart counters (pm2 reset)
 */
export class ResetCommand implements Command {
  name = 'reset';
  description = 'Reset the restart counter of a process, or of all';
  options = [jsonOption];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    await withDaemon('Failed to reset', async (client) => {
      const reset = await client.call('reset', name === undefined || name === 'all' ? {} : { name }) as string[];
      if (options['json'] === true) { console.log(JSON.stringify(reset)); return; }
      term.success(`Reset the restart counter of ${reset.length} process(es)`);
    });
  }
}

/**
 * signal - send a signal to a running process (pm2 sendSignal). Both `od signal api SIGUSR2` and
 * PM2's order, `od signal SIGUSR2 api`, work.
 */
export class SignalCommand implements Command {
  name = 'signal';
  description = 'Send a signal (SIGUSR2, HUP ...) to a process';
  options = [jsonOption];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const [first, second] = args;
    if (first === undefined || second === undefined) {
      term.error('Usage: od signal <name> <signal>   (e.g. od signal api SIGUSR2)');
      process.exit(1);
      return;
    }
    const isSignal = (value: string): boolean => /^(SIG)?[A-Z][A-Z0-9]+$/.test(value) && !/[a-z]/.test(value);
    const [name, signal] = isSignal(first) && !isSignal(second) ? [second, first] : [first, second];
    await withDaemon('Failed to send the signal', async (client) => {
      const pids = await client.call('signal', { name, signal }) as number[];
      if (options['json'] === true) { console.log(JSON.stringify({ name, signal, pids })); return; }
      const label = signal.toUpperCase().startsWith('SIG') ? signal.toUpperCase() : `SIG${signal.toUpperCase()}`;
      term.success(`Sent ${label} to ${name} (${pids.join(', ')})`);
    });
  }
}

/**
 * reload - replace a process without downtime where that is possible (pm2 reload): cluster apps
 * are replaced worker by worker, anything else is restarted
 */
export class ReloadCommand implements Command {
  name = 'reload';
  description = 'Reload a process without downtime (cluster mode), or restart it';
  options = [
    { name: 'cascade', type: 'boolean' as const, description: 'Also restart the apps that depend on it' },
    jsonOption,
  ];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    if (name === undefined) { term.error('No process name specified'); process.exit(1); return; }

    let mode: string | undefined;
    const client = new CliClient();
    try {
      await client.connect();
      mode = ((await client.getProcessInfo(name)) as { mode?: string } | null)?.mode;
    } catch (err) {
      term.error(`Failed to reload process: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
      return;
    } finally {
      await client.disconnect().catch(() => undefined);
    }

    if (mode === 'cluster') {
      await new DeployCommand().execute([name], { ...options, strategy: 'rolling' });
    } else {
      await new RestartCommand().execute([name], options);
    }
  }
}

/**
 * ping - is the daemon answering? (pm2 ping)
 */
export class PingCommand implements Command {
  name = 'ping';
  description = 'Check that the daemon answers';

  async execute(): Promise<void> {
    const client = new CliClient();
    try {
      await client.connect();
      await client.getDaemonStatus();
      term.success('pong');
    } catch {
      term.error('The daemon is not running');
      process.exit(1);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }
}

const ECOSYSTEM_TEMPLATE = `// OpenDaemon ecosystem file (PM2's ecosystem.config.js keys work too)
// Start everything:  od start ecosystem.config.cjs [--env production] [--only api]
module.exports = {
  apps: [
    {
      name: 'api',
      script: './server.js',
      args: '--port 3000',
      instances: 2,            // more than 1 runs in cluster mode
      exec_mode: 'cluster',
      max_memory_restart: '300M',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'cleanup',
      script: './cleanup.js',
      cron: '0 3 * * *',       // a scheduled job: runs at 03:00, not kept alive
    },
  ],
};
`;

/**
 * ecosystem - write a sample ecosystem file (pm2 ecosystem / init)
 */
export class EcosystemCommand implements Command {
  name = 'ecosystem';
  description = 'Write a sample ecosystem.config.cjs';

  execute(): Promise<void> {
    const target = resolve('ecosystem.config.cjs');
    if (existsSync(target)) {
      term.error(`${target} already exists`);
      process.exit(1);
      return Promise.resolve();
    }
    writeFileSync(target, ECOSYSTEM_TEMPLATE);
    term.success(`Wrote ${target}`);
    return Promise.resolve();
  }
}
