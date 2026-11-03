import type { OptionValue } from '../parser.js';
import type { Command } from './index.js';
import { StartCommand, getDaemonScriptPath } from './index.js';
import { term } from '../output.js';
import { CliClient } from '../client.js';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface Listed { name: string; status: string }
interface LogLine { processName: string; instanceId?: number; source: string; message: string }

/** Statuses of a process that is still doing something: the container must stay up */
const ACTIVE = new Set(['online', 'starting', 'stopping', 'waiting', 'reloading']);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * runtime - run apps in the foreground, for containers (pm2-runtime). Starts a private daemon,
 * starts the apps, prints their logs on stdout/stderr, passes SIGTERM/SIGINT on for a graceful
 * stop, and exits when the apps are gone: 0 if every one stopped cleanly, 1 if one failed.
 */
export class RuntimeCommand implements Command {
  name = 'runtime';
  description = 'Run apps in the foreground (for Docker): od runtime app.js | ecosystem.config.cjs';
  options = new StartCommand().options;

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    if (args.length === 0) {
      term.error('Usage: od runtime <script|ecosystem file> [start options]');
      process.exit(1);
      return;
    }

    // The daemon keeps its files in a private directory (OPENDAEMON_HOME, if set, is respected)
    const ownHome = process.env['OPENDAEMON_HOME'] === undefined || process.env['OPENDAEMON_HOME'] === '';
    const home = ownHome ? mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-rt-')) : (process.env['OPENDAEMON_HOME'] as string);
    process.env['OPENDAEMON_HOME'] = home;

    const daemonScript = getDaemonScriptPath();
    if (!existsSync(daemonScript)) { term.error(`Daemon script not found: ${daemonScript}`); process.exit(1); return; }
    // The daemon's own messages go to stderr, so stdout carries only what the apps print
    const daemon: ChildProcess = spawn(process.execPath, [daemonScript], { stdio: ['ignore', process.stderr, process.stderr] });
    const exit: { code: number | undefined } = { code: undefined };
    daemon.on('exit', (code) => { exit.code = code ?? 1; });
    const exited = (): number | undefined => exit.code;

    const cleanup = (): void => {
      if (exited() === undefined) daemon.kill('SIGKILL');
      if (ownHome) rmSync(home, { recursive: true, force: true });
    };
    process.on('exit', cleanup);

    const state = { stopping: false };
    const stop = (signal: NodeJS.Signals): void => {
      if (state.stopping) return;
      state.stopping = true;
      if (exited() === undefined) daemon.kill(signal === 'SIGINT' ? 'SIGTERM' : signal);
    };
    process.on('SIGTERM', () => { stop('SIGTERM'); });
    process.on('SIGINT', () => { stop('SIGINT'); });

    // The client reads the daemon's auth token when it is created, so each attempt makes a new one
    let client = new CliClient();
    try {
      for (let waited = 0; ; waited += 100) {
        if (exited() !== undefined) throw new Error(`The daemon exited with code ${String(exited())}`);
        if (waited > 15000) throw new Error('The daemon did not answer within 15s');
        client = new CliClient();
        try {
          await client.connect();
          await client.getDaemonStatus();
          break;
        } catch {
          await client.disconnect().catch(() => undefined);
          await sleep(100);
        }
      }

      await client.followLogs({ lines: 0 }, (entry) => {
        const line = entry as LogLine;
        const label = `${line.processName}${line.instanceId === undefined ? '' : `[${String(line.instanceId)}]`}`;
        (line.source === 'stderr' ? process.stderr : process.stdout).write(`${label} | ${line.message}\n`);
      });
      await new StartCommand().execute(args, options);
    } catch (err) {
      term.error(err instanceof Error ? err.message : String(err));
      stop('SIGTERM');
      await this.waitForDaemon(exit);
      process.exit(1);
      return;
    }

    // Until the daemon is told to stop or no app is left running
    let failed = false;
    while (exited() === undefined && !state.stopping) {
      await sleep(1000);
      try {
        const processes = await client.listProcesses() as Listed[];
        // A scheduled job waits between runs; it keeps the container up like a running app
        if (processes.length > 0 && !processes.some((p) => ACTIVE.has(p.status))) {
          failed = processes.some((p) => p.status === 'errored');
          if (!(await this.hasScheduled(client))) { stop('SIGTERM'); break; }
        }
      } catch {
        if (exited() !== undefined) break;
      }
    }

    await this.waitForDaemon(exit);
    await client.disconnect().catch(() => undefined);
    process.exit(failed || (exited() !== undefined && exited() !== 0 && !state.stopping) ? 1 : 0);
  }

  private async hasScheduled(client: CliClient): Promise<boolean> {
    try {
      return (await client.call('cron') as unknown[]).length > 0;
    } catch {
      return false;
    }
  }

  private async waitForDaemon(exit: { code: number | undefined }): Promise<void> {
    for (let waited = 0; exit.code === undefined && waited < 70000; waited += 100) await sleep(100);
  }
}
