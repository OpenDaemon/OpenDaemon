/**
 * End-to-end: the daemon itself is killed (SIGKILL, OOM killer). Its children keep running
 * unmanaged; the next daemon must stop them before it brings the saved apps back, or the copies
 * fight over their ports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const CLI = resolve('packages/cli/dist/cli.js');

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing the CLI's ANSI colours is the point
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!existsSync(CLI) || process.platform === 'win32')('daemon crash recovery end to end', () => {
  let root: string;
  let home: string;
  let project: string;
  const od = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1' }, encoding: 'utf-8', timeout: 40000 });
    return { status: result.status, out: strip(result.stdout) + strip(result.stderr) };
  };
  const list = () => JSON.parse(od('list', '--json').out) as Array<{ name: string; status: string; pid: number }>;

  beforeAll(() => {
    root = mkdtempSync(join(process.env['OD_E2E_TMP'] ?? '/tmp', 'od-crash-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(project);
    // Listens on a port chosen by the test, so a second copy fails like it would in production
    writeFileSync(join(project, 'srv.cjs'), "const s = require('http').createServer((q, r) => r.end('x')); s.on('error', (e) => { console.error('ERR ' + e.code); process.exit(1); }); s.listen(Number(process.env.SRV_PORT), () => console.log('listening ' + process.pid));");
  });
  afterAll(() => {
    od('daemon', 'stop');
    rmSync(root, { recursive: true, force: true });
  });

  it('stops the apps a killed daemon left behind and starts the saved ones once, without port clashes', async () => {
    const port = String(41000 + Math.floor(Math.random() * 2000));
    expect(od('start', 'srv.cjs', '--name', 'srv', '--env', `SRV_PORT=${port}`).status).toBe(0);
    od('save');
    await waitFor(() => list().some((p) => p.name === 'srv' && p.status === 'online'));
    const orphan = list().find((p) => p.name === 'srv')!.pid;
    expect(JSON.parse(readFileSync(join(home, 'children.json'), 'utf-8')) as object).toHaveProperty(String(orphan));

    process.kill(Number(readFileSync(join(home, 'opendaemon.pid'), 'utf-8')), 'SIGKILL');
    expect(alive(orphan)).toBe(true); // the point of the test: nobody stopped it

    // the next command starts a daemon, which reaps the orphan and resurrects the saved app
    const started = od('start', 'srv.cjs', '--name', 'second', '--env', `SRV_PORT=${String(Number(port) + 1)}`);
    expect(started.status).toBe(0);
    await waitFor(() => !alive(orphan));
    await waitFor(() => list().filter((p) => p.status === 'online').length === 2);
    const srv = list().find((p) => p.name === 'srv')!;
    expect(srv.pid).not.toBe(orphan);
    expect(od('logs', 'srv', '--raw', '--lines', '20').out).not.toContain('EADDRINUSE');
    expect(readFileSync(join(home, 'daemon.log'), 'utf-8')).toContain('left behind by a previous daemon: srv');
  });
});
