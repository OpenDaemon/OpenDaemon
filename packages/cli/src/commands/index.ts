import type { OptionValue } from '../parser.js';
import { term } from '../output.js';
import { CliClient } from '../client.js';
import { resolve } from 'path';
import { existsSync, readFileSync, unlinkSync, openSync, closeSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureHome, runtimePaths } from '../paths.js';
import { isEcosystemFile, loadEcosystem, splitArgs } from '../ecosystem.js';
import { runDeploy, sshRunner, validateTarget, type DeployCommandName } from '../remote-deploy.js';
import { isOnPath } from '../../../plugins/process-manager/src/launch.js';
import type { ProcessConfig } from '../../../core/src/index.js';
import { detectInit, planStartup, type InitSystem } from '../startup.js';
import { SecretStore, assertSecretName, toDotenv } from '../../../plugins/secret-manager/src/store.js';

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

      const spaced = processes.some((x) => (x as { namespace?: string }).namespace);
      const headers = ['ID', 'Name', ...(spaced ? ['Namespace'] : []), 'Mode', 'Status', 'CPU', 'Memory', 'Restarts', 'Uptime'];
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
          namespace?: string;
        };
        return [
          String(p.id),
          p.name,
          ...(spaced ? [p.namespace ?? 'default'] : []),
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
      case 'waiting':
        return term.color('yellow', '◌ waiting');
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
 * Environment variables from `--env KEY=value`; entries without `=` are profile names
 * (`--env production` picks `env_production` of an ecosystem file, like PM2)
 */
export function parseEnvOptions(value: OptionValue | undefined): { env: Record<string, string>; profile: string | undefined } {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const env: Record<string, string> = {};
  let profile: string | undefined;
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
    else if (entry !== '' && entry !== 'true') profile = entry;
    else throw new Error(`Invalid --env "${entry}" (expected KEY=value, or a profile name for a config file)`);
  }
  return { env, profile };
}

const num = (value: OptionValue | undefined): number | undefined => typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
const str = (value: OptionValue | undefined): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Start command - start a process, or the apps of an ecosystem/config file
 */
export class StartCommand implements Command {
  name = 'start';
  description = 'Start a process, a command, or the apps of an ecosystem file';
  options = [
    { name: 'name', alias: 'n', type: 'string' as const, description: 'Process name' },
    { name: 'instances', alias: 'i', type: 'string' as const, description: 'Number of instances (a number or max)' },
    { name: 'max-memory', type: 'string' as const, description: 'Max memory (e.g., 512M, 1G)' },
    { name: 'env', type: 'array' as const, description: 'KEY=value, or the env_<name> profile of a config file' },
    { name: 'cwd', type: 'string' as const, description: 'Working directory' },
    { name: 'namespace', type: 'string' as const, description: 'Group name: od restart <namespace> acts on all its members' },
    { name: 'interpreter', type: 'string' as const, description: 'Program that runs the script (python3, bash, none ...)' },
    { name: 'no-autorestart', type: 'boolean' as const, description: 'Do not restart the process when it exits' },
    { name: 'max-restarts', type: 'number' as const, description: 'Give up after this many restarts' },
    { name: 'restart-delay', type: 'number' as const, description: 'Milliseconds between restarts' },
    { name: 'kill-timeout', type: 'number' as const, description: 'Milliseconds to wait for exit before SIGKILL' },
    { name: 'cron-restart', type: 'string' as const, description: 'Restart at each match of this cron expression' },
    { name: 'output', type: 'string' as const, description: 'File for stdout (plain text copy)' },
    { name: 'error', type: 'string' as const, description: 'File for stderr (plain text copy)' },
    { name: 'log', type: 'string' as const, description: 'One file for stdout and stderr' },
    { name: 'time', type: 'boolean' as const, description: 'Prefix lines of those files with the time' },
    { name: 'node-args', type: 'string' as const, description: 'Arguments for node itself, e.g. "--max-old-space-size=200"' },
    { name: 'ignore-watch', type: 'string' as const, description: 'With --watch: paths to ignore (comma separated)' },
    { name: 'wait-ready', type: 'boolean' as const, description: "Online only once the app sends process.send('ready')" },
    { name: 'listen-timeout', type: 'number' as const, description: 'ms to wait for ready (default 3000)' },
    { name: 'stop-exit-codes', type: 'string' as const, description: 'Exit codes after which it is not restarted (comma separated)' },
    { name: 'only', type: 'string' as const, description: 'Config file: start only these apps (comma separated)' },
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
    let configs: ProcessConfigLike[];
    try {
      const { env, profile } = parseEnvOptions(options['env']);
      if (!isEcosystemFile(target) && profile !== undefined) {
        throw new Error(`Invalid --env "${profile}" (expected KEY=value; a bare name picks a profile of a config file)`);
      }
      configs = isEcosystemFile(target)
        ? await this.fromFile(target, options, env, profile)
        : [this.fromTarget(target, options, env)];
    } catch (err) {
      term.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    await ensureDaemonRunning();
    const failures: string[] = [];
    const client = new CliClient();
    try {
      await client.connect();
      for (const config of configs) {
        const spinner = term.spinner(`Starting ${config.name}...`);
        spinner.start();
        try {
          if (options['replace'] === true) {
            // startOrRestart / startOrReload: a running app gets the new config, cluster apps one worker at a time
            const existing = await client.getProcessInfo(config.name) as { status: string; mode?: string } | null;
            if (options['rolling'] === true && existing?.status === 'online' && existing.mode === 'cluster' && config.mode === 'cluster') {
              spinner.stop(true, `Reloading ${config.name}`);
              if (config.instances !== undefined) await client.scaleProcess(config.name, config.instances);
              await client.deployExecute({
                name: config.name, strategy: 'rolling',
                release: { script: config.script, ...(config.args === undefined ? {} : { args: config.args }), ...(config.env === undefined ? {} : { env: config.env }) },
              });
              await followDeploy(client, config.name, false);
              continue;
            }
            await client.call('replace', config);
          } else {
            await client.startProcess(config);
          }
          spinner.stop(true, `Started ${config.name}${config.mode === 'cluster' ? ` with ${String(config.instances ?? 1)} instance(s)` : ''}`);
        } catch (err) {
          spinner.stop(false);
          failures.push(config.name);
          term.error(`Failed to start ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      term.error(`Failed to start process: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
    if (failures.length > 0) process.exit(1);
  }

  /** Settings given as flags override what a file or the defaults say */
  private overrides(options: Record<string, OptionValue | undefined>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const maxMemory = str(options['max-memory']);
    if (maxMemory !== undefined) out['maxMemory'] = maxMemory;
    if (options['watch'] === true) out['watch'] = true;
    if (options['no-autorestart'] === true) out['autoRestart'] = false;
    const set = (key: string, value: unknown): void => { if (value !== undefined) out[key] = value; };
    set('maxRestarts', num(options['max-restarts']));
    set('restartDelay', num(options['restart-delay']));
    set('killTimeout', num(options['kill-timeout']));
    set('cronRestart', str(options['cron-restart']));
    set('namespace', str(options['namespace']));
    set('interpreter', str(options['interpreter']));
    const log = str(options['log']);
    if (log !== undefined) { out['logFile'] = resolve(log); out['mergeLogs'] = true; }
    const output = str(options['output']);
    if (output !== undefined) out['logFile'] = resolve(output);
    const errorFile = str(options['error']);
    if (errorFile !== undefined) out['errorLogFile'] = resolve(errorFile);
    if (options['time'] === true) out['logTimestamp'] = true;
    // A bare --node-args means its value started with "-" and was read as another option
    for (const name of ['node-args', 'output', 'error', 'log', 'ignore-watch', 'stop-exit-codes', 'cron-restart', 'interpreter']) {
      if (options[name] === true) throw new Error(`--${name} needs a value (for one that starts with "-", write --${name}=<value>)`);
    }
    const nodeArgs = str(options['node-args']);
    if (nodeArgs !== undefined) out['interpreterArgs'] = splitArgs(nodeArgs);
    const ignore = str(options['ignore-watch']);
    if (ignore !== undefined && options['watch'] === true) {
      out['watch'] = { ignore: ignore.split(',').map((p) => p.trim()).filter(Boolean) };
    }
    if (options['wait-ready'] === true) out['waitReady'] = true;
    set('listenTimeout', num(options['listen-timeout']));
    const codes = str(options['stop-exit-codes']);
    if (codes !== undefined) {
      const parsed = codes.split(',').map((c) => Number(c.trim()));
      if (parsed.some((c) => !Number.isInteger(c))) throw new Error(`Invalid --stop-exit-codes "${codes}" (whole numbers, comma separated)`);
      out['stopExitCodes'] = parsed;
    }
    return out;
  }

  private async fromFile(
    target: string,
    options: Record<string, OptionValue | undefined>,
    env: Record<string, string>,
    profile: string | undefined
  ): Promise<ProcessConfigLike[]> {
    const only = str(options['only'])?.split(',').map((n) => n.trim()).filter(Boolean);
    const loaded = await loadEcosystem(target, { ...(profile === undefined ? {} : { profile }), ...(only === undefined ? {} : { only }) });
    for (const warning of loaded.warnings) term.warn(warning);
    const name = str(options['name']);
    if (name !== undefined && loaded.apps.length > 1) throw new Error('--name cannot rename several apps; use --only to pick one');
    return loaded.apps.map(({ config, warnings }) => {
      for (const warning of warnings) term.warn(`${config.name}: ${warning}`);
      const merged: ProcessConfigLike = {
        ...config,
        ...this.overrides(options),
        ...(name === undefined ? {} : { name }),
        ...(Object.keys(env).length === 0 ? {} : { env: { ...config.env, ...env } }),
      };
      const instances = parseInstances(options['instances']);
      if (instances !== undefined) Object.assign(merged, { instances, mode: instances === 1 ? 'fork' : 'cluster' });
      return merged;
    });
  }

  private fromTarget(
    target: string,
    options: Record<string, OptionValue | undefined>,
    env: Record<string, string>
  ): ProcessConfigLike {
    const appArgs = Array.isArray(options['--']) ? options['--'] : [];
    let script = resolve(target);
    let args = appArgs;
    let interpreter: string | undefined;

    if (!existsSync(script)) {
      // `od start "npm start"` / `od start docker -- compose up`: a command, not a file
      const [program = '', ...rest] = splitArgs(target);
      if (program === '' || !isOnPath(program)) {
        throw new Error(`Script not found: ${target}`);
      }
      script = program;
      args = [...rest, ...appArgs];
      interpreter = 'none';
    }

    const fileName = script.split(/[/\\]/).pop() ?? script;
    const name = str(options['name']) ?? fileName.replace(/(?<=.)\.[^.]+$/, '');
    const instances = parseInstances(options['instances']) ?? 1;
    const config: ProcessConfigLike = {
      name,
      script,
      instances,
      mode: instances === 1 ? 'fork' : 'cluster',
      cwd: str(options['cwd']) === undefined ? process.cwd() : resolve(str(options['cwd']) as string),
      ...(args.length === 0 ? {} : { args }),
      ...(interpreter === undefined ? {} : { interpreter }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...this.overrides(options),
    };
    return config;
  }
}

type ProcessConfigLike = ProcessConfig & Record<string, unknown>;

/**
 * `-i 4` / `-i max`; undefined when not given
 */
export function parseInstances(value: OptionValue | undefined): number | 'max' | undefined {
  if (value === undefined || value === true || value === '') return undefined;
  if (value === 'max' || value === 'MAX') return 'max';
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --instances "${String(value)}" (a whole number above 0, or max)`);
  return n;
}

/**
 * Stop command - stop a process
 */
export class StopCommand implements Command {
  name = 'stop';
  description = 'Stop process(es)';
  options = [
    { name: 'json', type: 'boolean' as const, description: 'Output as JSON' },
    { name: 'cascade', type: 'boolean' as const, description: 'Stop the apps that depend on it first' },
  ];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    if (name === undefined) { term.error('No process name specified'); process.exit(1); return; }

    const spinner = term.spinner(`Stopping ${name}...`);
    spinner.start();

    try {
      const client = new CliClient();
      await client.connect();
      await client.stopProcess(name, undefined, undefined, options['cascade'] === true);
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
  options = [
    { name: 'strategy', type: 'string' as const, description: 'Replace workers without downtime: rolling, blue-green or canary (cluster mode)' },
    { name: 'cascade', type: 'boolean' as const, description: 'Also restart the apps that depend on it, once it is ready' },
    { name: 'env', type: 'array' as const, description: 'KEY=value for this and later runs' },
  ];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    if (name === undefined) { term.error('No process name specified'); process.exit(1); return; }

    if (typeof options['strategy'] === 'string') {
      await new DeployCommand().execute([name], options);
      return;
    }

    const spinner = term.spinner(`Restarting ${name}...`);
    spinner.start();

    try {
      const client = new CliClient();
      await client.connect();
      const { env } = parseEnvOptions(options['env']);
      await client.restartProcess(name, options['cascade'] === true, Object.keys(env).length > 0 ? env : undefined);
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
    const name = args[0];
    if (name === undefined) { term.error('No process name specified'); process.exit(1); return; }

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
    const name = args[0];
    if (name === undefined) { term.error('No process name specified'); process.exit(1); return; }

    try {
      const client = new CliClient();
      await client.connect();
      const info = await client.getProcessInfo(name) as {
        id: number; name: string; status: string; mode: string; pid: number;
        instances: number; runningInstances: number; cpu: number; memory: number;
        restartCount: number; uptime: number; script: string; cwd: string; startedAt: string;
        errorMessage?: string;
      } | null;
      await client.disconnect();

      if (!info) { term.error(`Process "${name}" not found`); process.exit(1); }

      console.log(`\n${term.bold(info.name)}`);
      console.log(term.keyValue('  Status', info.status));
      if (info.errorMessage) console.log(term.keyValue('  Reason', info.errorMessage));
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
 * Metrics command - Prometheus text (default) or the JSON report
 */
export class MetricsCommand implements Command {
  name = 'metrics';
  description = 'Show host, process and app metrics';
  options = [];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const json = options['json'] === true;
    try {
      const client = new CliClient();
      await client.connect();
      const result = await client.getMetrics(json ? 'json' : 'prometheus');
      await client.disconnect();
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : String(result));
    } catch (err) {
      term.error(`Failed to get metrics: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Read a secret value from stdin when it is piped (keeps it out of the shell history)
 */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // A trailing newline from `echo` or a file is not part of the secret
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
}

/**
 * Secret command - manage the encrypted secret store (works without a running daemon)
 */
export class SecretCommand implements Command {
  name = 'secret';
  description = 'Manage encrypted secrets';
  options = [];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const [action, name, value] = args;
    const store = new SecretStore(ensureHome().home);

    try {
      switch (action) {
        case 'set':
        case 'rotate': {
          if (name === undefined) throw new Error(`Usage: od secret ${action} <name> [value]  (or pipe the value on stdin)`);
          assertSecretName(name);
          const secret = value ?? await readStdin();
          if (secret === undefined) throw new Error(`Pass the value or pipe it: echo -n "..." | od secret ${action} ${name}`);
          const version = store.set(name, secret);
          term.success(`Stored ${name} (version ${String(version)})`);
          if (action === 'rotate') await this.notifyDaemon(name);
          return;
        }
        case 'get': {
          if (name === undefined) throw new Error('Usage: od secret get <name>');
          const secret = store.get(name);
          if (secret === undefined) throw new Error(`Secret "${name}" is not set`);
          process.stdout.write(`${secret}\n`);
          return;
        }
        case 'list': {
          const secrets = store.list();
          if (options['json'] === true) {
            console.log(JSON.stringify(secrets, null, 2));
          } else if (secrets.length === 0) {
            term.info('No secrets stored');
          } else {
            console.log(term.table(['Name', 'Version', 'Updated'], secrets.map((s) => [s.name, String(s.version), s.updatedAt])));
          }
          return;
        }
        case 'delete': {
          if (name === undefined) throw new Error('Usage: od secret delete <name>');
          if (!store.delete(name)) throw new Error(`Secret "${name}" is not set`);
          term.success(`Deleted ${name}`);
          return;
        }
        case 'export': {
          // Decrypted output on purpose: for local development only
          for (const { name: key } of store.list()) {
            process.stdout.write(`${toDotenv(key, store.get(key) ?? '')}\n`);
          }
          return;
        }
        default:
          throw new Error('Usage: od secret <set|get|list|delete|export|rotate> [name] [value]');
      }
    } catch (err) {
      term.error((err instanceof Error ? err : new Error(String(err))).message);
      process.exit(1);
    }
  }

  private async notifyDaemon(name: string): Promise<void> {
    const client = new CliClient();
    if (!client.isDaemonRunning()) {
      term.info('Daemon is not running; processes pick up the new value when they start');
      return;
    }
    await client.connect();
    const restarted = await client.secretRotated(name) as string[];
    await client.disconnect();
    term.info(restarted.length === 0 ? 'No running process uses it' : `Restarted: ${restarted.join(', ')}`);
  }
}

/**
 * Startup / unstartup commands - run the daemon at boot (systemd, launchd, OpenRC, Windows Task Scheduler)
 */
export class StartupCommand implements Command {
  name = 'startup';
  description = 'Generate a startup script so the daemon starts at boot';
  options = [];

  constructor(private readonly remove = false) {
    if (remove) {
      this.name = 'unstartup';
      this.description = 'Remove the startup script';
    }
  }

  execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const init = (typeof options['init'] === 'string' ? options['init'] : detectInit(process.platform, existsSync)) as InitSystem | undefined;
    if (init !== 'systemd' && init !== 'launchd' && init !== 'openrc' && init !== 'schtasks') {
      term.error('No supported init system found; pass --init systemd|launchd|openrc|schtasks');
      process.exit(1);
      return Promise.resolve();
    }

    const plan = planStartup({
      init,
      system: options['system'] === true,
      node: process.execPath,
      daemonScript: getDaemonScriptPath(),
      workingDirectory: process.cwd(),
      home: ensureHome().home,
      user: process.env['SUDO_USER'] ?? process.env['USER'],
    });
    const run = options['enable'] === true;

    try {
      if (this.remove) {
        if (!existsSync(plan.file)) { term.info(`Nothing to remove: ${plan.file} does not exist`); return Promise.resolve(); }
        this.runOrShow(plan.disable, run);
        unlinkSync(plan.file);
        term.success(`Removed ${plan.file}`);
        return Promise.resolve();
      }

      if (options['print'] === true) {
        console.log(`# ${plan.file}\n${plan.content}`);
        return Promise.resolve();
      }
      mkdirSync(resolve(plan.file, '..'), { recursive: true });
      writeFileSync(plan.file, plan.content, { mode: 0o644 });
      term.success(`Wrote ${plan.file}`);
      this.runOrShow(plan.enable, run);
    } catch (err) {
      const message = (err instanceof Error ? err : new Error(String(err))).message;
      term.error(`Failed: ${message}${message.includes('EACCES') ? ' (system-wide setup needs root; try sudo, or omit --system)' : ''}`);
      process.exit(1);
    }
    return Promise.resolve();
  }

  private runOrShow(commands: string[], run: boolean): void {
    if (!run) {
      console.log('Run:');
      for (const command of commands) console.log(`  ${command}`);
      console.log('(or pass --enable to run them)');
      return;
    }
    for (const command of commands) {
      const result = spawnSync(command, { shell: true, stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`"${command}" exited with ${String(result.status)}`);
    }
  }
}

/**
 * Audit command - who did what, newest last
 */
export class AuditCommand implements Command {
  name = 'audit';
  description = 'Show the audit log';
  options = [];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const lines = typeof options['lines'] === 'number' ? options['lines'] : 50;
    try {
      const client = new CliClient();
      await client.connect();
      const entries = await client.getAudit(lines) as Array<{
        timestamp: string; action: string; target?: { name?: string }; result: string; error?: string; duration?: number;
        actor: { type: string; user?: string };
      }>;
      await client.disconnect();

      if (options['json'] === true) {
        for (const entry of entries) console.log(JSON.stringify(entry));
        return;
      }
      if (entries.length === 0) {
        term.info('No audit entries');
        return;
      }
      for (const e of entries) {
        const outcome = e.result === 'success' ? term.color('green', 'ok  ') : term.color('red', 'FAIL');
        const who = e.actor.user ?? e.actor.type;
        const detail = [e.target?.name, e.error, e.duration === undefined ? undefined : `${String(e.duration)}ms`].filter(Boolean).join('  ');
        console.log(`${term.dim(e.timestamp)} ${outcome} ${e.action.padEnd(22)} ${who.padEnd(10)} ${detail}`);
      }
    } catch (err) {
      term.error(`Failed to get the audit log: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Cron command - scheduled jobs, their next run and last result
 */
export class CronCommand implements Command {
  name = 'cron';
  description = 'Show scheduled jobs';
  options = [];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    try {
      const client = new CliClient();
      await client.connect();
      const jobs = await client.getCronJobs() as Array<{
        name: string; cron: string; timezone?: string; nextRun?: string;
        history: Array<{ startedAt: string; result: string; exitCode?: number | null; attempt: number }>;
      }>;
      await client.disconnect();

      if (options['json'] === true) {
        console.log(JSON.stringify(jobs, null, 2));
        return;
      }
      if (jobs.length === 0) {
        term.info('No scheduled jobs (set `cron` on an app)');
        return;
      }
      const rows = jobs.map((job) => {
        const last = job.history.at(-1);
        const result = last === undefined ? '-' : `${last.result}${last.exitCode === undefined || last.exitCode === null ? '' : ` (exit ${String(last.exitCode)})`}`;
        return [
          job.name,
          job.timezone === undefined ? job.cron : `${job.cron} (${job.timezone})`,
          job.nextRun ?? 'never',
          last?.startedAt ?? '-',
          result,
        ];
      });
      console.log(term.table(['Name', 'Schedule', 'Next run', 'Last run', 'Result'], rows));
    } catch (err) {
      term.error(`Failed to get scheduled jobs: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Scale command - change the number of cluster workers
 */
export class ScaleCommand implements Command {
  name = 'scale';
  description = 'Change the number of cluster workers';
  options = [];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    const [name, count] = args;
    const instances = count === 'max' ? 'max' : Number(count);
    if (name === undefined || count === undefined || (instances !== 'max' && (!Number.isInteger(instances) || instances < 1))) {
      term.error('Usage: od scale <name> <instances|max>');
      process.exit(1);
      return;
    }

    try {
      const client = new CliClient();
      await client.connect();
      const info = await client.scaleProcess(name, instances) as { instances: number };
      await client.disconnect();
      term.success(`Scaled ${name} to ${String(info.instances)} instance(s)`);
    } catch (err) {
      term.error(`Failed to scale: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Health command - show health check status
 */
export class HealthCommand implements Command {
  name = 'health';
  description = 'Show health check status';
  options = [];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];

    try {
      const client = new CliClient();
      await client.connect();
      const reports = await client.getHealth(name) as Array<{
        name: string; type: string; status: string; consecutiveFailures: number;
        lastResult?: { ok: boolean; message: string; at: string };
      }>;
      await client.disconnect();

      if (reports.length === 0) {
        term.info(name === undefined ? 'No health checks configured' : `No health check configured for "${name}"`);
        return;
      }

      const rows = reports.map((r) => [
        r.name,
        r.type,
        this.formatStatus(r.status),
        String(r.consecutiveFailures),
        r.lastResult ? `${formatDuration(Date.now() - Date.parse(r.lastResult.at))} ago` : '-',
        r.lastResult?.message ?? '-',
      ]);
      console.log(term.table(['Name', 'Type', 'Health', 'Failures', 'Last check', 'Result'], rows));
    } catch (err) {
      term.error(`Failed to get health: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }

  private formatStatus(status: string): string {
    switch (status) {
      case 'healthy':
        return term.color('green', '● healthy');
      case 'unhealthy':
        return term.color('red', '✗ unhealthy');
      default:
        return term.color('gray', '◌ pending');
    }
  }
}

/**
 * Parse --since: a relative duration ("30s", "15m", "2h", "1d") or an absolute date
 */
export function parseSince(value: string, now = Date.now()): number | undefined {
  const relative = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (relative?.[1] && relative[2]) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 's' | 'm' | 'h' | 'd'];
    return now - Number(relative[1]) * unit;
  }
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? undefined : absolute;
}

interface LogLine {
  timestamp: string;
  processName: string;
  instanceId?: number;
  source: 'stdout' | 'stderr';
  message: string;
}

/**
 * Logs command - view, search and follow process logs
 */
export class LogsCommand implements Command {
  name = 'logs';
  description = 'View process logs';
  options = [];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    const json = options['json'] === true;
    const follow = options['follow'] === true;
    const lines = typeof options['lines'] === 'number' ? options['lines'] : 100;
    const grep = typeof options['grep'] === 'string' ? options['grep'] : undefined;

    let since: number | undefined;
    if (options['since'] !== undefined) {
      since = parseSince(String(options['since']));
      if (since === undefined) {
        term.error(`Invalid --since "${String(options['since'])}" (use e.g. 30m, 2h, 1d or a date)`);
        process.exit(1);
        return;
      }
    }

    // PM2's --err / --out: only stderr or only stdout
    const source = options['err'] === true && options['out'] !== true ? 'stderr' : options['out'] === true && options['err'] !== true ? 'stdout' : undefined;
    const raw = options['raw'] === true;
    const filter = {
      ...(name === undefined ? {} : { name }),
      ...(grep === undefined ? {} : { grep }),
      ...(source === undefined ? {} : { source }),
    };
    const print = (entry: LogLine) => {
      if (json) {
        console.log(JSON.stringify(entry));
        return;
      }
      if (raw) {
        console.log(entry.message);
        return;
      }
      const label = `${entry.processName}${entry.instanceId === undefined ? '' : `[${String(entry.instanceId)}]`}`;
      const tag = term.color(entry.source === 'stderr' ? 'red' : 'cyan', label);
      console.log(`${term.dim(entry.timestamp)} ${tag} ${entry.message}`);
    };

    try {
      const client = new CliClient();
      await client.connect();
      const entries = await client.queryLogs({ ...filter, lines, ...(since === undefined ? {} : { since }) }) as LogLine[];
      entries.forEach(print);
      if (entries.length === 0 && !follow && !json) {
        term.info(name === undefined ? 'No logs found' : `No logs found for "${name}"`);
      }

      if (!follow) {
        await client.disconnect();
        return;
      }

      await client.followLogs(filter, (entry) => { print(entry as LogLine); });
      // Stream until Ctrl+C or until the daemon goes away
      await new Promise<void>((resolveFollow) => {
        const timer = setInterval(() => {
          if (!client.isConnected()) {
            clearInterval(timer);
            resolveFollow();
          }
        }, 500);
        process.once('SIGINT', () => {
          clearInterval(timer);
          resolveFollow();
        });
      });
      await client.disconnect();
    } catch (err) {
      term.error(`Failed to get logs: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Flush command - empty log files
 */
export class FlushCommand implements Command {
  name = 'flush';
  description = 'Empty process log files';
  options = [];

  async execute(args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    try {
      const client = new CliClient();
      await client.connect();
      const { flushed } = await client.flushLogs(name) as { flushed: string[] };
      await client.disconnect();
      if (flushed.length === 0) {
        term.info('No logs to flush');
      } else {
        term.success(`Flushed logs: ${flushed.join(', ')}`);
      }
    } catch (err) {
      term.error(`Failed to flush logs: ${(err instanceof Error ? err : new Error(String(err))).message}`);
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


/**
 * Last lines the daemon wrote to its log since `offset`, for explaining a failed start
 */
function readLogTail(logFile: string, offset: number, lines = 10): string {
  try {
    const output = readFileSync(logFile).subarray(offset).toString('utf-8').trim();
    // Stack frames would push the actual error message out of view
    const meaningful = output.split('\n').filter((line) => !/^\s+at /.test(line));
    return meaningful.length > 0 ? `\n${meaningful.slice(-lines).join('\n')}` : '';
  } catch {
    return '';
  }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function getDaemonScriptPath(): string {
  // Resolve next to this module, not cwd, so `od` works from any directory.
  // Bundled: dist/chunk-*.js sits beside dist/daemon.js. Source: src/commands/../daemon.ts
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const distPath = resolve(moduleDir, 'daemon.js');
  const srcPath = resolve(moduleDir, '..', 'daemon.ts');
  if (existsSync(distPath)) return distPath;
  return srcPath;
}

async function daemonAnswers(): Promise<boolean> {
  try {
    const client = new CliClient();
    await client.connect();
    await client.getDaemonStatus();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon command - manage daemon
 */
/**
 * Start the daemon when it is not running, like PM2 does on the first command. Several commands
 * started at once (a script, a CI step) race here: only one of them spawns the daemon, the others
 * wait for it (see withStartLock).
 */
export async function ensureDaemonRunning(): Promise<void> {
  if (new CliClient().isDaemonRunning() && await daemonAnswers()) return;
  await new DaemonCommand().startDaemon(true);
}

/**
 * Run `body` while holding the daemon start lock: a file created exclusively, holding the PID of
 * the command that owns it. A lock whose owner is gone is taken over.
 */
async function withStartLock<T>(body: () => Promise<T>, timeoutMs = 30000): Promise<T> {
  const lock = resolve(ensureHome().home, 'daemon-start.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      // Windows reports a lock that another command is deleting, or has open, as EPERM/EBUSY/EACCES
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      let owner = NaN;
      try { owner = parseInt(readFileSync(lock, 'utf-8'), 10); } catch { /* released meanwhile */ }
      if (!Number.isNaN(owner) && !isProcessRunning(owner)) {
        try { unlinkSync(lock); } catch { /* someone else took it over */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error('Another od command has been starting the daemon for too long');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await body();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

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

  /**
   * Start the daemon unless it runs. `quiet` stays silent when it already does (the implicit start
   * of `od start`); the lock makes concurrent callers take turns.
   */
  async startDaemon(quiet = false): Promise<void> {
    try {
      await withStartLock(() => this.spawnDaemon(quiet));
    } catch (err) {
      term.error(`Failed to start daemon: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }

  private async spawnDaemon(quiet: boolean): Promise<void> {
    const { pidFile, socketFile, daemonLog: logFile } = ensureHome();

    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
      if (isProcessRunning(pid)) {
        if (!quiet) term.info(`Daemon is already running (PID: ${pid})`);
        return;
      }
      unlinkSync(pidFile);
    }

    const spinner = term.spinner('Starting daemon...');
    spinner.start();

    try {
      if (existsSync(socketFile)) unlinkSync(socketFile);
      const daemonScript = getDaemonScriptPath();
      if (!existsSync(daemonScript)) throw new Error(`Daemon script not found: ${daemonScript}`);

      // Daemon output goes to a log file instead of being discarded, so a failed start can be explained
      const logOffset = existsSync(logFile) ? statSync(logFile).size : 0;
      const logFd = openSync(logFile, 'a');
      const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: ['ignore', logFd, logFd] });
      closeSync(logFd);

      // "Started" means it answers over IPC. The PID file is written before the config is loaded,
      // so a daemon that is about to exit on a bad config would otherwise be reported as started.
      const deadline = Date.now() + 15000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 100));
        if (child.exitCode !== null) {
          throw new Error(`Daemon exited with code ${String(child.exitCode)}${readLogTail(logFile, logOffset)}`);
        }
        if (await daemonAnswers()) break;
        if (Date.now() > deadline) throw new Error(`Daemon did not answer within 15s${readLogTail(logFile, logOffset)}`);
      }

      child.unref();
      spinner.stop(true, 'Daemon started');
    } catch (err) {
      spinner.stop(false);
      throw err;
    }
  }

  private async stopDaemon(): Promise<void> {
    const { pidFile, socketFile, tokenFile } = runtimePaths();
    const removeStaleFiles = () => {
      for (const file of [pidFile, socketFile, tokenFile]) {
        if (existsSync(file)) unlinkSync(file);
      }
    };

    if (!existsSync(pidFile)) { term.info('Daemon is not running'); return; }
    const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
    if (!isProcessRunning(pid)) {
      removeStaleFiles();
      term.info('Daemon is not running (cleaned up stale files)');
      return;
    }

    const spinner = term.spinner('Stopping daemon...');
    spinner.start();

    try {
      // Ask over IPC first: on Windows a signal terminates the daemon outright, skipping the
      // teardown that stops managed processes (which Windows would otherwise leave running)
      let requested = false;
      try {
        const client = new CliClient();
        await client.connect();
        await client.shutdownDaemon();
        await client.disconnect();
        requested = true;
      } catch {
        // Unreachable or older daemon: fall back to a signal
      }
      if (!requested) process.kill(pid, 'SIGTERM');

      await new Promise<void>((resolve) => {
        let attempts = 0;
        const checkStopped = () => {
          attempts++;
          if (!isProcessRunning(pid)) { resolve(); return; }
          // The daemon stops apps level by level (dependents first), each up to its killTimeout;
          // killing it early would orphan whatever it is still stopping, so allow a minute
          if (attempts >= 600) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } resolve(); return; }
          setTimeout(checkStopped, 100);
        };
        setTimeout(checkStopped, 100);
      });

      // The daemon removes these itself; this only matters when it had to be killed
      removeStaleFiles();
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
    const { pidFile } = runtimePaths();
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

/**
 * Print the steps of a deploy as they happen, until it ends; exits non-zero unless it succeeded
 */
export async function followDeploy(client: CliClient, name: string, json: boolean): Promise<void> {
  interface State { state: string; strategy: string; steps: string[]; error?: string }
  let shown = 0;
  for (;;) {
    const state = await client.deployStatus(name) as State | null;
    if (!state) throw new Error(`No deploy of "${name}"`);
    if (!json) {
      for (const step of state.steps.slice(shown)) term.info(`  ${step}`);
      shown = state.steps.length;
    }
    if (state.state !== 'running') {
      if (json) console.log(JSON.stringify(state, null, 2));
      if (state.state === 'succeeded') {
        if (!json) term.success(`Deployed ${name} (${state.strategy})`);
        return;
      }
      if (!json) term.error(`Deploy of ${name} ${state.state}: ${state.error ?? 'unknown error'}`);
      process.exit(1);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Deploy command - replace a running app's code without downtime
 */
export class DeployCommand implements Command {
  name = 'deploy';
  description = 'Deploy a new release (rolling, blue-green, canary, recreate)';
  options = [
    { name: 'strategy', type: 'string' as const, description: 'rolling, blue-green, canary or recreate (default: the app\'s deploy.strategy)' },
    { name: 'script', type: 'string' as const, description: 'New script (the release to run)' },
    { name: 'env', type: 'array' as const, description: 'Environment overrides for the release (KEY=value)' },
    { name: 'release', type: 'string' as const, description: 'Version label (workers see it as OD_RELEASE)' },
    { name: 'json', type: 'boolean' as const, description: 'Output as JSON' },
  ];

  /**
   * `od deploy <ecosystem file> <env> [setup|update|revert [n]|curr|prev|exec "cmd"|list]` (pm2 deploy):
   * pull a release on the hosts of `deploy.<env>` over ssh and run its hooks
   */
  private async remote(args: string[]): Promise<void> {
    const [file = '', envName, rawCommand = 'update', ...rest] = args;
    try {
      const { deploy } = await loadEcosystem(file);
      if (deploy === undefined) throw new Error(`${file} has no "deploy" section`);
      if (envName === undefined) throw new Error(`Usage: od deploy ${file} <${Object.keys(deploy).join('|')}> [setup|update|revert [n]|curr|prev|exec "cmd"|list]`);
      if (rawCommand === 'list' || envName === 'list') {
        for (const [name, block] of Object.entries(deploy)) {
          const hosts = (block as { host?: string | string[] }).host;
          term.info(`${name}: ${(Array.isArray(hosts) ? hosts : [hosts ?? '?']).join(', ')}`);
        }
        return;
      }
      if (!(envName in deploy)) throw new Error(`No deploy.${envName} in ${file} (it has: ${Object.keys(deploy).join(', ')})`);
      const target = validateTarget(envName, deploy[envName]);
      const known: DeployCommandName[] = ['setup', 'update', 'deploy', 'revert', 'curr', 'current', 'prev', 'previous', 'exec'];
      if (!known.includes(rawCommand as DeployCommandName)) throw new Error(`Unknown deploy command "${rawCommand}" (setup, update, revert, curr, prev, exec, list)`);
      const argument = rawCommand === 'exec' ? rest.join(' ') : rest[0];
      await runDeploy(target, rawCommand as DeployCommandName, sshRunner(target), argument);
      term.success(`${rawCommand} done on ${(Array.isArray(target.host) ? target.host : [target.host]).join(', ')}`);
    } catch (err) {
      term.error(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const json = options['json'] === true;
    if (args[0] !== undefined && isEcosystemFile(args[0]) && existsSync(resolve(args[0]))) {
      await this.remote(args);
      return;
    }
    try {
      const client = new CliClient();
      await client.connect();

      // od deploy status [name]
      if (args[0] === 'status') {
        const state = await client.deployStatus(args[1]);
        await client.disconnect();
        if (json || state === null) console.log(JSON.stringify(state, null, 2));
        else for (const s of Array.isArray(state) ? state : [state]) {
          const d = s as { name: string; state: string; strategy: string; version?: string; startedAt: string; error?: string; steps: string[] };
          term.info(`${d.name}  ${d.state}  ${d.strategy}${d.version ? `  ${d.version}` : ''}  started ${d.startedAt}`);
          for (const step of d.steps.slice(-8)) term.info(`  ${step}`);
          if (d.error) term.error(`  ${d.error}`);
        }
        return;
      }

      const name = args[0];
      if (name === undefined) { term.error('Usage: od deploy <name> [--strategy s] [--script path] [--env K=V] [--release label]\n       od deploy status [name]'); process.exit(1); return; }

      const env: Record<string, string> = {};
      const envOption = options['env'];
      for (const entry of Array.isArray(envOption) ? envOption : typeof envOption === 'string' ? [envOption] : []) {
        const eq = entry.indexOf('=');
        if (eq < 1) { term.error(`Invalid --env "${entry}" (expected KEY=value)`); process.exit(1); return; }
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      const release = {
        ...(typeof options['script'] === 'string' ? { script: options['script'] } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(typeof options['release'] === 'string' ? { version: options['release'] } : {}),
      };
      await client.deployExecute({
        name,
        ...(typeof options['strategy'] === 'string' ? { strategy: options['strategy'] } : {}),
        release,
      });
      await followDeploy(client, name, json);
      await client.disconnect();
    } catch (err) {
      term.error(`Deploy failed: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}

/**
 * Rollback command - go back to the release from before the last deploy
 */
export class RollbackCommand implements Command {
  name = 'rollback';
  description = 'Roll back to the release before the last deploy';
  options = [{ name: 'json', type: 'boolean' as const, description: 'Output as JSON' }];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    if (name === undefined) { term.error('Usage: od rollback <name>'); process.exit(1); return; }
    try {
      const client = new CliClient();
      await client.connect();
      await client.deployRollback(name);
      await followDeploy(client, name, options['json'] === true);
      await client.disconnect();
    } catch (err) {
      term.error(`Rollback failed: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
    }
  }
}
