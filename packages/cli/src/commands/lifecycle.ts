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

/**
 * pid - print the process ids (pm2 pid), of one app or of all
 */
export class PidCommand implements Command {
  name = 'pid';
  description = 'Print the process ids of an app, or of all';

  async execute(args: string[]): Promise<void> {
    const name = args[0];
    await withDaemon('Failed to read the pids', async (client) => {
      const list = await client.call('list') as Array<{ name: string; pids?: number[] }>;
      const picked = name === undefined ? list : list.filter((p) => p.name === name);
      if (name !== undefined && picked.length === 0) throw new Error(`Process "${name}" not found`);
      for (const p of picked) for (const pid of p.pids ?? []) console.log(String(pid));
    });
  }
}

/**
 * env - the environment an app is configured with (pm2 env)
 */
export class EnvCommand implements Command {
  name = 'env';
  description = 'Print the environment an app is configured with';
  options = [jsonOption];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const name = args[0];
    if (name === undefined) { term.error('Usage: od env <name>'); process.exit(1); return; }
    await withDaemon('Failed to read the environment', async (client) => {
      const env = await client.call('env', { name }) as Record<string, string>;
      if (options['json'] === true) { console.log(JSON.stringify(env)); return; }
      for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
    });
  }
}

/**
 * The static file server `od serve` runs, as the source of `node -e`: no files to ship, no
 * dependencies. argv: directory, port, spa ('1' or ''), host. Paths cannot leave the directory.
 */
export const STATIC_SERVER = `
const http = require('http'), fs = require('fs'), path = require('path');
const [root, port, spa, host] = process.argv.slice(1);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.xml': 'application/xml', '.pdf': 'application/pdf' };
function send(res, file, status) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(status, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
}
http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (pathname.includes('\\0')) { res.writeHead(400); res.end(); return; }
  let file = path.join(root, path.normalize(pathname));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, stat) => {
    if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
    fs.stat(file, (err2, stat2) => {
      if (!err2 && stat2.isFile()) { send(res, file, 200); return; }
      if (spa && !path.extname(pathname)) { send(res, path.join(root, 'index.html'), 200); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    });
  });
}).listen(Number(port), host, () => console.log('serving ' + root + ' on http://' + host + ':' + port));
`;

/**
 * serve - static file server as a managed app (pm2 serve)
 */
export class ServeCommand implements Command {
  name = 'serve';
  description = 'Serve a directory over HTTP as a managed app: od serve [dir] [port] [--spa]';
  options = [
    { name: 'name', alias: 'n', type: 'string' as const, description: 'Process name (default: serve-<port>)' },
    { name: 'spa', type: 'boolean' as const, description: 'Answer unknown paths with index.html (single page apps)' },
    { name: 'host', type: 'string' as const, description: 'Address to listen on (default 0.0.0.0)' },
    jsonOption,
  ];

  async execute(args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    const root = resolve(args[0] ?? '.');
    const port = Number(args[1] ?? 8080);
    if (!existsSync(root)) { term.error(`Directory not found: ${root}`); process.exit(1); return; }
    if (!Number.isInteger(port) || port < 0 || port > 65535) { term.error(`Invalid port "${String(args[1])}"`); process.exit(1); return; }
    const host = typeof options['host'] === 'string' ? options['host'] : '0.0.0.0';
    const name = typeof options['name'] === 'string' ? options['name'] : `serve-${String(port)}`;

    await withDaemon('Failed to serve', async (client) => {
      await client.startProcess({
        name,
        script: process.execPath,
        interpreter: 'none',
        args: ['-e', STATIC_SERVER, root, String(port), options['spa'] === true ? '1' : '', host],
        cwd: root,
        mode: 'fork',
      });
      if (options['json'] === true) { console.log(JSON.stringify({ name, root, port, host, spa: options['spa'] === true })); return; }
      term.success(`Serving ${root} on http://${host === '0.0.0.0' ? 'localhost' : host}:${String(port)} as "${name}"`);
    }, true);
  }
}
