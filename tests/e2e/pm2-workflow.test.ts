/**
 * End-to-end: the PM2 way of working against the built `od` CLI: start with no daemon, an
 * ecosystem file with env profiles, commands and other-language scripts, save, and come back
 * after the daemon restarts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const CLI = resolve('packages/cli/dist/cli.js');

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing the CLI's ANSI colours is the point
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!existsSync(CLI))('PM2-style workflow end to end', () => {
  let root: string;
  let home: string;
  let project: string;

  const od = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 40000,
    });
    return { status: result.status, out: strip(result.stdout) + strip(result.stderr) };
  };
  const list = () => JSON.parse(od('list', '--json').out) as Array<{ name: string; status: string; pid: number; restarts: number }>;
  const online = (...names: string[]) => () => names.every((n) => list().some((p) => p.name === n && p.status === 'online'));
  const logs = (name: string) => od('logs', name, '--lines', '50').out;

  beforeAll(() => {
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-pm2-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'api.cjs'), "console.log('api mode=' + process.env.APP_MODE + ' args=' + process.argv.slice(2).join(',')); setInterval(() => {}, 1000);");
    writeFileSync(join(project, 'job.sh'), 'echo "shell job says $GREETING"; sleep 30');
    writeFileSync(join(project, 'ecosystem.config.cjs'), `module.exports = {
      apps: [
        { name: 'api', script: './api.cjs', args: '--port 8080', env: { APP_MODE: 'dev' }, env_production: { APP_MODE: 'prod' }, max_memory_restart: '300M', pmx: false },
        { name: 'job', script: './job.sh', env: { GREETING: 'hi' }, autorestart: false },
      ],
    };`);
  });

  afterAll(() => {
    od('daemon', 'stop');
    rmSync(root, { recursive: true, force: true });
  });

  it('starts the daemon by itself and the apps of an ecosystem file, with the production env profile', async () => {
    expect(existsSync(join(home, 'opendaemon.pid'))).toBe(false);
    const result = od('start', 'ecosystem.config.cjs', '--env', 'production');
    expect(result.status).toBe(0);
    expect(result.out).toContain('Started api');
    expect(result.out).toContain('Started job');
    await waitFor(online('api', 'job'));
    await waitFor(() => logs('api').includes('api mode=prod args=--port,8080'));
    await waitFor(() => logs('job').includes('shell job says hi'));
  });

  it('starts a single app from the file with --only, and a command with arguments after --', async () => {
    od('delete', 'job');
    expect(od('start', 'ecosystem.config.cjs', '--only', 'job').out).toContain('Started job');
    expect(od('start', 'node', '--name', 'inline', '--', '-e', 'console.log("inline args ok"); setInterval(()=>{},1000)').out).toContain('Started inline');
    await waitFor(online('job', 'inline'));
    await waitFor(() => logs('inline').includes('inline args ok'));
    expect(od('start', 'ecosystem.config.cjs', '--only', 'nope').out).toMatch(/Not in .*: nope/);
  });

  it('saves the process list and brings it back when the daemon starts again', async () => {
    expect(od('save').out).toContain('Saved 3 process(es)');
    expect(od('daemon', 'stop').status).toBe(0);
    expect(od('daemon', 'start').out).toContain('Daemon started');
    await waitFor(online('api', 'job', 'inline'));
    await waitFor(() => logs('api').includes('api mode=prod'));
  });

  it('resurrect restarts a saved app that was stopped', async () => {
    od('stop', 'inline');
    await waitFor(() => list().find((p) => p.name === 'inline')?.status === 'stopped');
    const result = od('resurrect', '--json');
    expect(JSON.parse(result.out.trim().split('\n').pop() as string)).toMatchObject({ started: ['inline'] });
    await waitFor(online('inline'));
  });

  it('restarts, stops and resets several processes at once with all', async () => {
    const pids = () => new Map(list().map((p) => [p.name, p.pid]));
    const before = pids();
    expect(od('restart', 'all').out).toContain('Restarted api');
    await waitFor(online('api', 'job', 'inline'));
    await waitFor(() => [...before].every(([name, pid]) => pids().get(name) !== pid));
    expect(od('reset', 'all').out).toContain('Reset the restart counter of 3 process(es)');
    expect(od('stop', 'api', 'job').status).toBe(0);
    await waitFor(() => ['api', 'job'].every((n) => list().find((p) => p.name === n)?.status === 'stopped'));
    expect(od('restart', 'all').status).toBe(0);
    await waitFor(online('api', 'job', 'inline'));
  });

  it('sends a signal in either argument order, and answers ping and describe', async () => {
    writeFileSync(join(project, 'usr.cjs'), "process.on('SIGUSR2', () => console.log('usr2 received')); setInterval(() => {}, 1000);");
    od('start', 'usr.cjs');
    await waitFor(online('usr'));
    expect(od('signal', 'usr', 'SIGUSR2').out).toMatch(/Sent SIGUSR2 to usr/);
    await waitFor(() => logs('usr').includes('usr2 received'));
    expect(od('signal', 'USR2', 'usr').out).toMatch(/Sent SIGUSR2 to usr/);
    expect(od('signal', 'usr', 'NOPE').status).toBe(1);
    expect(od('ping').out).toContain('pong');
    expect(od('describe', 'usr').out).toMatch(/Status: online/);
    expect(JSON.parse(od('jlist').out).length).toBeGreaterThanOrEqual(4);
  });

  it('writes a sample ecosystem file that od start accepts, and does not overwrite it', async () => {
    const fresh = join(root, 'fresh');
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'server.js'), 'setInterval(() => {}, 1000);');
    writeFileSync(join(fresh, 'cleanup.js'), 'process.exit(0);');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: fresh, env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1' }, encoding: 'utf-8' });
    expect(run('ecosystem').status).toBe(0);
    expect(run('ecosystem').status).toBe(1);
    od('delete', 'api');
    const started = run('start', 'ecosystem.config.cjs', '--env', 'production');
    expect(strip(started.stdout)).toContain('Started api with 2 instance(s)');
    await waitFor(online('api'));
    // the cron app is scheduled, not run now
    expect(list().find((p) => p.name === 'cleanup')?.status).toBe('stopped');
    expect(JSON.parse(od('cron', '--json').out).map((j: { name: string }) => j.name)).toContain('cleanup');
    expect(od('reload', 'api').status).toBe(0);
  });
});
