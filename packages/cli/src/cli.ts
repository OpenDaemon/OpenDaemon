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
import { term } from './output.js';
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
    type: 'number',
    description: 'Number of instances',
  });

  parser.addOption({
    name: 'env',
    type: 'array',
    description: 'Environment variable for the process (KEY=value), repeatable',
  });

  parser.addOption({ name: 'strategy', type: 'string', description: 'od deploy / restart: rolling, blue-green, canary or recreate' });
  parser.addOption({ name: 'script', type: 'string', description: 'od deploy: the new script to run' });
  parser.addOption({ name: 'release', type: 'string', description: 'od deploy: version label' });
  parser.addOption({ name: 'init', type: 'string', description: 'Init system for od startup: systemd, launchd or openrc' });
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

  // Parse arguments
  const args = process.argv.slice(2);
  const parsed = parser.parse(args);

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
 * Execute a command
 */
async function executeCommand(parsed: ParsedCommand): Promise<void> {
  const command = parsed.command;
  const subcommand = parsed.subcommand;

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
