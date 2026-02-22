import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { term } from '../output.js';

/**
 * Get package version
 */
function getVersion(): string {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')
    );
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

/**
 * CLI help text
 */
export const helpText = `
${term.bold('OpenDaemon')} - Next-generation process manager for Node.js

${term.bold('VERSION')}
  ${getVersion()}

${term.bold('USAGE')}
  od <command> [options] [args]

${term.bold('COMMANDS')}

  Process Management:
    start    Start a process or processes from config
    stop     Stop process(es)
    restart  Restart process(es)
    reload   Zero-downtime reload
    delete   Remove process(es)
    scale    Scale instances

  Monitoring:
    list     List all processes
    info     Show detailed process information
    monit    Real-time TUI dashboard
    status   Show quick status overview

  Logs:
    logs     View logs
    flush    Flush logs

  Daemon:
    daemon   Manage daemon (start, stop, restart, status)

  Configuration:
    init     Generate config file
    validate Validate config file

  Other:
    help     Show help
    version  Show version

${term.bold('GLOBAL OPTIONS')}

  -c, --config <path>    Config file path
  -j, --json           Output as JSON
  -q, --quiet          Minimal output
  -v, --verbose        Verbose output
  --no-color          Disable colors
  -h, --help          Show help

${term.bold('EXAMPLES')}

  Start a process:
    $ od start app.js

  Start with config:
    $ od start opendaemon.config.ts

  List processes:
    $ od list

  Stop a process:
    $ od stop my-app

  View logs:
    $ od logs my-app -f

  Start daemon:
    $ od daemon start

${term.bold('DOCUMENTATION')}
  https://opendaemon.dev

${term.bold('LICENSE')}
  MIT
`;

/**
 * Show help
 */
export function showHelp(): void {
  console.log(helpText);
}

/**
 * Show version
 */
export function showVersion(): void {
  console.log(getVersion());
}
