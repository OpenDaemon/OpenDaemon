/**
 * End-to-end: the PM2 way of working against the built `od` CLI: start with no daemon, an
 * ecosystem file with env profiles, commands and other-language scripts, save, and come back
 * after the daemon restarts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
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
  const list = () => JSON.parse(od('list', '--json').out) as Array<{ name: string; status: string; pid: number; restarts: number; instances: number }>;
  const online = (...names: string[]) => () => names.every((n) => list().some((p) => p.name === n && p.status === 'online'));
  const logs = (name: string) => od('logs', name, '--lines', '50').out;

  beforeAll(() => {
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-pm2-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'api.cjs'), "console.log('api mode=' + process.env.APP_MODE + ' args=' + process.argv.slice(2).join(',')); setInterval(() => {}, 1000);");
    // the dashboard on a free port: 7777 may be taken by anything else on the machine
    writeFileSync(join(project, 'opendaemon.config.json'), JSON.stringify({ plugins: { webui: { port: 0 } } }));
    writeFileSync(join(project, 'plain.cjs'), 'setInterval(() => {}, 1000);');
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
    // Windows keeps a directory busy while a process still has it as its cwd
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp dir, left behind */ }
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

  it('a namespace groups apps: list shows it and restart acts on every member', async () => {
    writeFileSync(join(project, 'ns.cjs'), 'setInterval(() => {}, 1000);');
    expect(od('start', 'ns.cjs', '--name', 'ns-a', '--namespace', 'grp').status).toBe(0);
    expect(od('start', 'ns.cjs', '--name', 'ns-b', '--namespace', 'grp').status).toBe(0);
    await waitFor(online('ns-a', 'ns-b'));
    expect(od('list').out).toContain('grp');
    const pids = () => new Map(list().map((p) => [p.name, p.pid]));
    const before = pids();
    expect(od('restart', 'grp').status).toBe(0);
    await waitFor(() => ['ns-a', 'ns-b'].every((n) => pids().get(n) !== before.get(n)));
    expect(pids().get('api')).toBe(before.get('api'));
    expect(od('delete', 'grp').status).toBe(0);
    await waitFor(() => !list().some((p) => p.name.startsWith('ns-')));
  });

  it('starting an ecosystem file again restarts the apps that exist and adds the new ones', async () => {
    writeFileSync(join(project, 'again.cjs'), 'setInterval(() => {}, 1000);');
    const eco = (names: string[]) => { writeFileSync(join(project, 'again.config.js'),
      `module.exports = { apps: [${names.map((n) => `{ name: '${n}', script: 'again.cjs' }`).join(',')}] };`); };
    eco(['again-a']);
    expect(od('start', 'again.config.js').status).toBe(0);
    await waitFor(online('again-a'));
    const before = list().find((p) => p.name === 'again-a')?.pid;
    eco(['again-a', 'again-b']);
    const second = od('start', 'again.config.js');
    expect(second.status).toBe(0);
    await waitFor(online('again-a', 'again-b'));
    await waitFor(() => list().find((p) => p.name === 'again-a')?.pid !== before);
    expect(od('start', 'again.cjs', '--name', 'again-a').status).toBe(1);
    expect(od('delete', 'again-a', 'again-b').status).toBe(0);
  });

  it('scale takes +n and -n relative to the current number of workers', async () => {
    writeFileSync(join(project, 'scaled.cjs'), 'setInterval(() => {}, 1000);');
    od('start', 'scaled.cjs', '-i', '2');
    await waitFor(online('scaled'));
    const instances = () => list().find((p) => p.name === 'scaled')?.instances;
    expect(od('scale', 'scaled', '+2').status).toBe(0);
    expect(instances()).toBe(4);
    expect(od('scale', 'scaled', '-1').status).toBe(0);
    expect(instances()).toBe(3);
    expect(od('scale', 'scaled', '-3').status).toBe(1);
    expect(instances()).toBe(3);
    expect(od('scale', 'scaled', '2').status).toBe(0);
    expect(instances()).toBe(2);
    od('delete', 'scaled');
  });

  it('refuses to start an app whose working directory is missing', () => {
    writeFileSync(join(project, 'cwdcheck.cjs'), 'setInterval(() => {}, 1000);');
    const result = od('start', 'cwdcheck.cjs', '--cwd', join(project, 'no-such-dir'));
    expect(result.status).toBe(1);
    expect(result.out).toContain('Working directory not found');
    expect(list().find((p) => p.name === 'cwdcheck')?.status).not.toBe('online');
    od('delete', 'cwdcheck');
  });

  it('update restarts the daemon and brings the saved apps back', async () => {
    const result = od('update');
    expect(result.status).toBe(0);
    expect(result.out).toContain('Daemon restarted');
    await waitFor(online('api', 'job', 'inline'));
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

  it.runIf(process.platform !== 'win32')('sends a signal in either argument order', async () => {
    writeFileSync(join(project, 'usr.cjs'), "process.on('SIGUSR2', () => console.log('usr2 received')); setInterval(() => {}, 1000);");
    od('start', 'usr.cjs');
    await waitFor(online('usr'));
    expect(od('signal', 'usr', 'SIGUSR2').out).toMatch(/Sent SIGUSR2 to usr/);
    await waitFor(() => logs('usr').includes('usr2 received'));
    expect(od('signal', 'USR2', 'usr').out).toMatch(/Sent SIGUSR2 to usr/);
    expect(od('signal', 'usr', 'NOPE').status).toBe(1);
  });

  it('addresses processes by id, filters logs by stream, prints pids and env, and restarts with new env', async () => {
    writeFileSync(join(project, 'two.cjs'), "console.log('to-out'); console.error('to-err'); console.log('mode=' + process.env.MODE); setInterval(() => {}, 1000);");
    od('start', 'two.cjs', '--env', 'MODE=one');
    await waitFor(online('two'));
    const id = String(list().find((p) => p.name === 'two')!.pid && (JSON.parse(od('list', '--json').out) as Array<{ id: number; name: string }>).find((p) => p.name === 'two')!.id);

    await waitFor(() => logs('two').includes('to-err'));
    expect(od('logs', 'two', '--err', '--raw').out.trim()).toBe('to-err');
    expect(od('logs', 'two', '--out', '--raw').out).toContain('to-out');
    expect(od('logs', 'two', '--out', '--raw').out).not.toContain('to-err');
    expect(od('logs', id, '--raw').out).toContain('to-out');

    const pid = String(list().find((p) => p.name === 'two')!.pid);
    expect(od('pid', 'two').out.trim()).toBe(pid);
    expect(od('env', 'two').out.trim()).toBe('MODE=one');

    expect(od('restart', id, '--env', 'MODE=two').out).toContain('Restarted two');
    await waitFor(() => list().find((p) => p.name === 'two')?.pid !== Number(pid) && online('two')());
    await waitFor(() => logs('two').includes('mode=two'));
    expect(od('env', id).out.trim()).toBe('MODE=two');
    expect(od('stop', id).status).toBe(0);
    await waitFor(() => list().find((p) => p.name === 'two')?.status === 'stopped');
    expect(od('pid', 'ghost').status).toBe(1);
    // PM2's other spellings
    expect(od('id', 'two').out.trim()).toBe(id);
    expect(od('id', 'ghost').status).toBe(1);
    expect(od('ps').out).toContain('two');
    expect(od('l').out).toContain('two');
    expect(od('dump').out).toContain('Saved');
  });

  it('answers ping, describe and jlist', async () => {
    od('start', 'plain.cjs');
    await waitFor(online('plain'));
    expect(od('ping').out).toContain('pong');
    expect(od('describe', 'plain').out).toMatch(/Status: online/);
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

  it('keeps the WebUI closed to other local users: anonymous requests are refused, the login is in a private file', async () => {
    const log = readFileSync(join(home, 'daemon.log'), 'utf-8');
    const port = [...log.matchAll(/WebUI server listening on http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1])).pop();
    expect(port).toBeDefined();
    const anonymous = await fetch(`http://127.0.0.1:${String(port)}/api/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'intruder', script: '/bin/sh', interpreter: 'none', args: ['-c', 'sleep 30'] }),
    });
    expect(anonymous.status).toBe(401);
    expect(list().some((p) => p.name === 'intruder')).toBe(false);

    const credentials = readFileSync(join(home, 'webui-credentials'), 'utf-8');
    const password = /^password: (.+)$/m.exec(credentials)?.[1] ?? '';
    const authorised = await fetch(`http://127.0.0.1:${String(port)}/api/processes`, { headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } });
    expect(authorised.status).toBe(200);
    if (process.platform !== 'win32') expect(statSync(join(home, 'webui-credentials')).mode & 0o777).toBe(0o600);
  });
  // Last: it stops the shared daemon (Windows has one fixed IPC port, so a second daemon cannot run beside it)
  it('lets many commands start at once without a daemon: one starts it, all of them work', async () => {
    expect(od('daemon', 'stop').status).toBe(0);
    const spawnOd = (name: string) => new Promise<{ status: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [CLI, 'start', 'plain.cjs', '--name', name], { cwd: project, env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1' } });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('exit', (status) => { done({ status, out }); });
    });
    const names = Array.from({ length: 10 }, (_, i) => `race${String(i)}`);
    const results = await Promise.all(names.map(spawnOd));
    expect(results.filter((r) => r.status !== 0).map((r) => r.out)).toEqual([]);
    expect(results.filter((r) => r.out.includes('Daemon started'))).toHaveLength(1);
    // saved apps come back with the daemon, so the list holds more than the ten
    const listed = list().map((p) => p.name);
    expect(listed).toEqual(expect.arrayContaining(names));
  });
});
