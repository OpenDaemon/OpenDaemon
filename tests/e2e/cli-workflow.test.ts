/**
 * End-to-end tests: the built `od` CLI against a real daemon.
 * Run with `npm run test:e2e` (builds first). Each suite gets its own OPENDAEMON_HOME
 * and project directory, so nothing touches ~/.opendaemon.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const CLI = resolve('packages/cli/dist/cli.js');
const CORE = pathToFileURL(resolve('packages/core/dist/index.js')).href;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Short temp root: Unix socket paths are limited to ~108 bytes */
function tempRoot(): string {
  return mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-e2e-'));
}

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing the CLI's ANSI colours is the point
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

function makeOd(home: string, cwd: string) {
  return (...args: string[]): Result => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { status: result.status, stdout: strip(result.stdout), stderr: strip(result.stderr) };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!existsSync(CLI))('od CLI end to end', () => {
  let root: string;
  let home: string;
  let project: string;
  let elsewhere: string;
  let od: ReturnType<typeof makeOd>;
  let odElsewhere: ReturnType<typeof makeOd>;

  const list = () => JSON.parse(odElsewhere('list', '--json').stdout) as Array<{ name: string; status: string; pid: number }>;

  beforeAll(() => {
    root = tempRoot();
    home = join(root, 'home');
    project = join(root, 'project');
    elsewhere = join(root, 'elsewhere');
    mkdirSync(project);
    mkdirSync(elsewhere);

    writeFileSync(join(project, 'web.cjs'), [
      "const http = require('http');",
      "const server = http.createServer((req, res) => { console.log('request ' + req.url); res.end('ok'); });",
      "server.listen(0, '127.0.0.1', () => console.log('listening on ' + server.address().port));",
      "setInterval(() => console.error('heartbeat warning'), 200);",
    ].join('\n'));
    writeFileSync(join(project, 'worker.cjs'), "setInterval(() => console.log('working'), 200);");
    writeFileSync(join(project, 'opendaemon.config.yaml'), [
      'apps:',
      '  - name: web',
      '    script: ./web.cjs',
      '    healthCheck:',
      '      type: process',
      '      interval: 200',
      'plugins:',
      '  webui:',
      '    port: 0',
    ].join('\n'));

    od = makeOd(home, project);
    odElsewhere = makeOd(home, elsewhere);
  });

  afterAll(() => {
    od('daemon', 'stop');
    rmSync(root, { recursive: true, force: true });
  });

  it('should print the package version', () => {
    const { stdout, status } = od('--version');
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should report that no daemon is running', () => {
    expect(odElsewhere('status').stdout).toContain('Daemon: not running');
  });

  it('should start the daemon and the configured apps', async () => {
    const result = od('daemon', 'start');
    expect(result.stdout + result.stderr).toContain('Daemon started');
    await waitFor(() => list().some((p) => p.name === 'web' && p.status === 'online'));
  });

  it('should keep runtime files in OPENDAEMON_HOME, not the project directory', () => {
    const files = readdirSync(home);
    expect(files).toEqual(expect.arrayContaining(['opendaemon.pid', 'auth-token', 'daemon.log']));
    expect(readdirSync(project).sort()).toEqual(['opendaemon.config.yaml', 'web.cjs', 'worker.cjs']);
  });

  it('should start, inspect and restart a process from another directory', async () => {
    const started = odElsewhere('start', join(project, 'worker.cjs'), '--name', 'worker');
    expect(started.stdout + started.stderr).toContain('Started worker');
    await waitFor(() => list().some((p) => p.name === 'worker' && p.status === 'online'));

    const before = list().find((p) => p.name === 'worker')!.pid;
    expect(odElsewhere('info', 'worker').stdout).toMatch(/Status: online/);
    expect(odElsewhere('restart', 'worker').stdout).toContain('Restarted worker');
    await waitFor(() => {
      const now = list().find((p) => p.name === 'worker');
      return now?.status === 'online' && now.pid !== before;
    });
  });

  it('should search logs by process and pattern, and flush them', async () => {
    await waitFor(() => od('logs', 'web', '--grep', 'heartbeat', '--lines', '1').stdout.includes('heartbeat warning'));
    // The restarted worker logs every 200ms; wait for its first line
    await waitFor(() => od('logs', 'worker', '--lines', '1').stdout.includes('working'));

    const json = od('logs', '--json', '--lines', '200').stdout.trim().split('\n').map((l) => JSON.parse(l) as { processName: string; source: string });
    expect(new Set(json.map((e) => e.processName))).toEqual(new Set(['web', 'worker']));
    expect(json.some((e) => e.processName === 'web' && e.source === 'stderr')).toBe(true);

    expect(od('flush', 'worker').stdout).toContain('Flushed logs: worker');
  });

  it('should report health for processes with a health check', async () => {
    await waitFor(() => od('health', 'web').stdout.includes('healthy'));
    expect(od('health', 'worker').stdout).toContain('No health check configured for "worker"');
  });

  it('should refuse IPC requests that do not carry the auth token', () => {
    if (process.platform === 'win32') return; // TCP endpoint; same server-side check
    const script = [
      `const { IpcClient } = await import(${JSON.stringify(CORE)});`,
      `const client = new IpcClient({ socketPath: ${JSON.stringify(join(home, 'opendaemon.sock'))}, timeout: 3000 });`,
      'await client.connect();',
      "try { await client.call('list'); console.log('ACCEPTED'); } catch (e) { console.log('REJECTED ' + e.message); }",
      'await client.disconnect();',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', timeout: 10000 });
    expect(result.stdout).toContain('REJECTED Invalid auth token');
  });

  it('should stop and delete processes, then stop the daemon cleanly', async () => {
    expect(odElsewhere('stop', 'worker').stdout).toContain('Stopped worker');
    await waitFor(() => list().find((p) => p.name === 'worker')?.status === 'stopped');
    odElsewhere('delete', 'worker');
    expect(list().map((p) => p.name)).toEqual(['web']);

    const webPid = list()[0]!.pid;
    expect(od('daemon', 'stop').stdout).toContain('Daemon stopped');
    expect(existsSync(join(home, 'opendaemon.pid'))).toBe(false);
    expect(existsSync(join(home, 'auth-token'))).toBe(false);
    expect(() => process.kill(webPid, 0)).toThrow();
    expect(odElsewhere('status').stdout).toContain('Daemon: not running');
  });
});

describe.skipIf(!existsSync(CLI))('od daemon with an invalid config', () => {
  it('should fail to start, explain why and leave no runtime files', () => {
    const root = tempRoot();
    try {
      const home = join(root, 'home');
      const project = join(root, 'project');
      mkdirSync(project);
      writeFileSync(join(project, 'opendaemon.config.yaml'), 'apps:\n  - name: broken\n');

      const result = makeOd(home, project)('daemon', 'start');
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('Process "broken" must have a script');
      expect(readdirSync(home)).toEqual(['daemon.log']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
