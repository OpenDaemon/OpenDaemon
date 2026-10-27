import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { term } from '../output.js';

// Injected by tsup from the root package.json; undefined when running from source
declare const __OPENDAEMON_VERSION__: string | undefined;

/**
 * Get package version
 */
export function getVersion(): string {
  if (typeof __OPENDAEMON_VERSION__ === 'string') {
    return __OPENDAEMON_VERSION__;
  }
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')
    ) as { version?: string };
    return pkg.version as string;
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
    start <script>   Start a process
    stop <name>      Stop a process
    restart <name>   Restart a process
    delete <name>    Remove a process
    scale <name> <n> Change cluster workers (number or max)

  Monitoring:
    list / ls        List all processes
    info <name>      Show detailed process information
    logs [name]      View logs (--lines N, -f, --grep RE, --since 2h, --json)
    flush [name]     Empty log files
    health [name]    Show health check status
    metrics          Prometheus metrics (--json for the JSON report)
    cron             Scheduled jobs: next run and last result
    secret <action>  Encrypted secrets: set, get, list, delete, export, rotate
    status           Show daemon and process overview
    monit            Live terminal dashboard

  Daemon:
    daemon start     Start the daemon
    daemon stop      Stop the daemon
    daemon restart   Restart the daemon
    daemon status    Show daemon status

  Other:
    help             Show this help
    version          Show version

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
