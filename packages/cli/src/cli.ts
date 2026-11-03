#!/usr/bin/env node

import { CommandParser, type ParsedCommand } from './parser.js';
import {
  showHelp,
  showVersion,
} from './commands/help.js';
import {
  ListCommand,
  StartCommand,
  StopCommand,
  RestartCommand,
  DeleteCommand,
  InfoCommand,
  LogsCommand,
  FlushCommand,
  ScaleCommand,
  DeployCommand,
  RollbackCommand,
  MetricsCommand,
  CronCommand,
  SecretCommand,
  StartupCommand,
  AuditCommand,
  HealthCommand,
  StatusCommand,
  DaemonCommand,
} from './commands/index.js';
import { SaveCommand, ResurrectCommand, ResetCommand, SignalCommand, ReloadCommand, PingCommand, EcosystemCommand, PidCommand, EnvCommand, ServeCommand } from './commands/lifecycle.js';
import { CliClient } from './client.js';
import { RuntimeCommand } from './commands/runtime.js';
import { term } from './output.js';
import { basename } from 'path';
import { MonitCommand } from './tui/monit.js';

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  // `od logs | head` closes stdout early; that is a normal way to stop reading, not a crash
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  const parser = new CommandParser();

  // Global options
  parser.addOption({
    name: 'config',
    alias: 'c',
    type: 'string',
    description: 'Config file path',
  });

  parser.addOption({
    name: 'json',
    type: 'boolean',
    description: 'Output as JSON',
  });

  parser.addOption({
    name: 'quiet',
    alias: 'q',
    type: 'boolean',
    description: 'Minimal output',
  });

  parser.addOption({
    name: 'verbose',
    alias: 'v',
    type: 'boolean',
    description: 'Verbose output',
  });

  parser.addOption({
    name: 'help',
    alias: 'h',
    type: 'boolean',
    description: 'Show help',
  });

  parser.addOption({
    name: 'version',
    type: 'boolean',
    description: 'Show version',
  });

  // Add common command options
  parser.addOption({
    name: 'name',
    alias: 'n',
    type: 'string',
    description: 'Process name',
  });

  parser.addOption({
    name: 'instances',
    alias: 'i',
    type: 'string',
    description: 'Number of instances',
  });

  parser.addOption({
    name: 'env',
    type: 'array',
    description: 'Environment variable for the process (KEY=value), repeatable',
  });

  parser.addOption({ name: 'cwd', type: 'string', description: 'od start: working directory' });
  parser.addOption({ name: 'interpreter', type: 'string', description: 'od start: program that runs the script' });
  parser.addOption({ name: 'no-autorestart', type: 'boolean', description: 'od start: do not restart on exit' });
  parser.addOption({ name: 'max-restarts', type: 'number', description: 'od start: restart limit' });
  parser.addOption({ name: 'restart-delay', type: 'number', description: 'od start: ms between restarts' });
  parser.addOption({ name: 'kill-timeout', type: 'number', description: 'od start: ms before SIGKILL' });
  parser.addOption({ name: 'cron-restart', type: 'string', description: 'od start: restart on this cron schedule' });
  parser.addOption({ name: 'only', type: 'string', description: 'od start <file>: only these apps' });
  parser.addOption({ name: 'err', type: 'boolean', description: 'od logs: only stderr' });
  parser.addOption({ name: 'out', type: 'boolean', description: 'od logs: only stdout' });
  parser.addOption({ name: 'raw', type: 'boolean', description: 'od logs: the messages only' });
  parser.addOption({ name: 'nostream', type: 'boolean', description: 'od logs: print and exit (the default; accepted for PM2 scripts)' });
  for (const [name, type] of [['output', 'string'], ['error', 'string'], ['log', 'string'], ['time', 'boolean'], ['node-args', 'string'], ['ignore-watch', 'string'], ['wait-ready', 'boolean'], ['listen-timeout', 'number'], ['stop-exit-codes', 'string']] as const) {
    parser.addOption({ name, type, description: `od start: ${name}` });
  }
  parser.addOption({ name: 'spa', type: 'boolean', description: 'od serve: single page app fallback' });
  parser.addOption({ name: 'host', type: 'string', description: 'od serve: address to listen on' });
  parser.addOption({ name: 'cascade', type: 'boolean', description: 'od stop / restart: include the apps that depend on it' });
  parser.addOption({ name: 'strategy', type: 'string', description: 'od deploy / restart: rolling, blue-green, canary or recreate' });
  parser.addOption({ name: 'script', type: 'string', description: 'od deploy: the new script to run' });
  parser.addOption({ name: 'release', type: 'string', description: 'od deploy: version label' });
  parser.addOption({ name: 'init', type: 'string', description: 'Init system for od startup: systemd, launchd, openrc or schtasks' });
  parser.addOption({ name: 'system', type: 'boolean', description: 'od startup: install for the whole machine (needs root)' });
  parser.addOption({ name: 'print', type: 'boolean', description: 'od startup: print the script instead of writing it' });
  parser.addOption({ name: 'enable', type: 'boolean', description: 'od startup: also run the enable commands' });

  parser.addOption({
    name: 'watch',
    alias: 'w',
    type: 'boolean',
    description: 'Restart the process when files in its directory change',
  });

  parser.addOption({
    name: 'max-memory',
    type: 'string',
    description: 'Restart the process when it exceeds this memory (e.g. 512M)',
  });

  // Log options
  parser.addOption({
    name: 'lines',
    type: 'number',
    description: 'Number of log lines',
  });

  parser.addOption({
    name: 'follow',
    alias: 'f',
    type: 'boolean',
    description: 'Follow log output',
  });

  parser.addOption({
    name: 'grep',
    type: 'string',
    description: 'Filter log messages by regular expression',
  });

  parser.addOption({
    name: 'since',
    type: 'string',
    description: 'Only logs since a duration (2h) or date',
  });

  // Parse arguments. After a bare `--` everything belongs to the app: `od start app.js -- --port 80`
  const argv = process.argv.slice(2);
  // `od-runtime app.js` is `od runtime app.js` (pm2-runtime's counterpart)
  if (/^od-runtime(\.\w+)?$/.test(basename(process.argv[1] ?? ''))) argv.unshift('runtime');
  const dashes = argv.indexOf('--');
  const args = dashes === -1 ? argv : argv.slice(0, dashes);
  const parsed = parser.parse(args);
  if (dashes !== -1) parsed.options['--'] = argv.slice(dashes + 1);

  // Handle global flags
  if (parsed.options['help']) {
    showHelp();
    return;
  }

  if (parsed.options['version']) {
    showVersion();
    return;
  }

  // Handle commands
  try {
    await executeCommand(parsed);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    term.error(error.message);

    if (parsed.options['verbose']) {
      console.error(error.stack);
    }

    process.exit(1);
  }
}

/**
 * Names of every process the daemon manages, for `all`
 */
async function allProcessNames(): Promise<string[]> {
  const client = new CliClient();
  try {
    await client.connect();
    return (await client.listProcesses() as Array<{ name: string }>).map((p) => p.name);
  } catch (err) {
    term.error(`Failed to list processes: ${(err instanceof Error ? err : new Error(String(err))).message}`);
    process.exit(1);
    return [];
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/**
 * Execute a command
 */
/** Commands that take process names, and so also accept several of them and PM2's `all` */
const PER_PROCESS = new Set(['stop', 'restart', 'delete', 'reload', 'flush']);
/** Commands whose positional arguments are process names (all of them), or just the first one */
const NAMES_ALL = new Set(['stop', 'restart', 'delete', 'reload', 'reset', 'signal', 'sendSignal']);
const NAMES_FIRST = new Set(['info', 'describe', 'logs', 'flush', 'scale', 'health', 'deploy', 'rollback', 'pid', 'env']);

/**
 * PM2 addresses processes by id too (`od restart 0`): a number that is no process's name is
 * replaced by the name of the process with that id
 */
async function resolveIds(parsed: ParsedCommand): Promise<ParsedCommand> {
  const all = NAMES_ALL.has(parsed.command);
  if (!all && !NAMES_FIRST.has(parsed.command)) return parsed;
  const hasSub = parsed.subcommand !== '';
  const positional = hasSub ? [parsed.subcommand, ...parsed.args] : [...parsed.args];
  const numeric = positional.map((v, i) => (/^\d+$/.test(v) && (all || i === 0) ? i : -1)).filter((i) => i >= 0);
  if (numeric.length === 0) return parsed;

  const client = new CliClient();
  let processes: Array<{ id: number; name: string }>;
  try {
    await client.connect();
    processes = await client.listProcesses() as Array<{ id: number; name: string }>;
  } catch {
    return parsed; // no daemon: the command reports that itself
  } finally {
    await client.disconnect().catch(() => undefined);
  }
  for (const i of numeric) {
    const value = positional[i] as string;
    if (processes.some((p) => p.name === value)) continue;
    const byId = processes.find((p) => p.id === Number(value));
    if (byId) positional[i] = byId.name;
  }
  return hasSub ? { ...parsed, subcommand: positional[0] as string, args: positional.slice(1) } : { ...parsed, args: positional };
}

async function executeCommand(original: ParsedCommand): Promise<void> {
  const parsed = await resolveIds(original);
  const command = parsed.command;
  const subcommand = parsed.subcommand;

  if (PER_PROCESS.has(command)) {
    const names = [subcommand, ...parsed.args].filter((n) => n !== '');
    if (names.length > 1 || names[0] === 'all') {
      const targets = names.includes('all') ? await allProcessNames() : names;
      for (const name of targets) {
        await executeCommand({ ...parsed, subcommand: name, args: [] });
      }
      return;
    }
  }

  switch (command) {
    case '':
    case 'help':
      showHelp();
      break;

    case 'list':
    case 'ls': {
      const cmd = new ListCommand();
      await cmd.execute(parsed.args, parsed.options);
      break;
    }

    case 'start': {
      const cmd = new StartCommand();
      const startArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(startArgs, parsed.options);
      break;
    }

    case 'startOrRestart':
    case 'startOrReload':
    case 'startOrGracefulReload': {
      const startArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await new StartCommand().execute(startArgs, { ...parsed.options, replace: true, rolling: command !== 'startOrRestart' });
      break;
    }

    case 'stop': {
      const cmd = new StopCommand();
      const stopArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(stopArgs, parsed.options);
      break;
    }

    case 'restart': {
      const cmd = new RestartCommand();
      const restartArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(restartArgs, parsed.options);
      break;
    }

    case 'delete': {
      const cmd = new DeleteCommand();
      const deleteArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(deleteArgs, parsed.options);
      break;
    }

    case 'info': {
      const cmd = new InfoCommand();
      const infoArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(infoArgs, parsed.options);
      break;
    }

    case 'logs': {
      const cmd = new LogsCommand();
      const logsArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(logsArgs, parsed.options);
      break;
    }

    case 'audit': {
      await new AuditCommand().execute(parsed.args, parsed.options);
      break;
    }

    case 'startup':
    case 'unstartup': {
      await new StartupCommand(command === 'unstartup').execute([], parsed.options);
      break;
    }

    case 'secret': {
      const cmd = new SecretCommand();
      const secretArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(secretArgs, parsed.options);
      break;
    }

    case 'monit': {
      await new MonitCommand().execute(parsed.args, parsed.options);
      break;
    }

    case 'cron': {
      const cmd = new CronCommand();
      await cmd.execute(parsed.args, parsed.options);
      break;
    }

    case 'metrics': {
      const cmd = new MetricsCommand();
      await cmd.execute(parsed.args, parsed.options);
      break;
    }

    case 'scale': {
      const cmd = new ScaleCommand();
      const scaleArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(scaleArgs, parsed.options);
      break;
    }

    case 'deploy': {
      const deployArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await new DeployCommand().execute(deployArgs, parsed.options);
      break;
    }

    case 'rollback': {
      const rollbackArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await new RollbackCommand().execute(rollbackArgs, parsed.options);
      break;
    }

    case 'flush': {
      const cmd = new FlushCommand();
      const flushArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(flushArgs, parsed.options);
      break;
    }

    case 'health': {
      const cmd = new HealthCommand();
      const healthArgs = subcommand ? [subcommand, ...parsed.args] : parsed.args;
      await cmd.execute(healthArgs, parsed.options);
      break;
    }

    case 'status': {
      const cmd = new StatusCommand();
      await cmd.execute();
      break;
    }

    case 'runtime':
      await new RuntimeCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'reload':
      await new ReloadCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'reset':
      await new ResetCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'signal':
    case 'sendSignal':
      await new SignalCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'serve':
      await new ServeCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'pid':
      await new PidCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args);
      break;

    case 'env':
      await new EnvCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'ping':
      await new PingCommand().execute();
      break;

    case 'ecosystem':
    case 'init':
      await new EcosystemCommand().execute();
      break;

    case 'describe':
      await new InfoCommand().execute(subcommand ? [subcommand, ...parsed.args] : parsed.args, parsed.options);
      break;

    case 'jlist':
    case 'prettylist':
      await new ListCommand().execute([], { ...parsed.options, json: true });
      break;

    case 'kill':
      await new DaemonCommand().execute(['stop']);
      break;

    case 'save':
      await new SaveCommand().execute(parsed.args, parsed.options);
      break;

    case 'resurrect':
      await new ResurrectCommand().execute(parsed.args, parsed.options);
      break;

    case 'daemon': {
      const cmd = new DaemonCommand();
      await cmd.execute([subcommand, ...parsed.args]);
      break;
    }

    default:
      term.error(`Unknown command: ${command}`);
      console.log('\nRun `od help` for available commands.');
      process.exit(1);
  }
}

// Run main
main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
