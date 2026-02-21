#!/usr/bin/env node

import { CommandParser, type ParsedCommand, type OptionValue } from './parser.js';
import {
  showHelp,
  showVersion,
} from './commands/help.js';
import {
  ListCommand,
  StartCommand,
  StopCommand,
  StatusCommand,
  DaemonCommand,
} from './commands/index.js';
import { term } from './output.js';

/**
 * CLI entry point
 */
async function main(): Promise<void> {
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
      await cmd.execute([subcommand, ...parsed.args], parsed.options);
      break;
    }

    case 'start': {
      const cmd = new StartCommand();
      await cmd.execute([subcommand, ...parsed.args], parsed.options);
      break;
    }

    case 'stop': {
      const cmd = new StopCommand();
      await cmd.execute([subcommand, ...parsed.args], parsed.options);
      break;
    }

    case 'status': {
      const cmd = new StatusCommand();
      await cmd.execute([subcommand, ...parsed.args], parsed.options);
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
main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
