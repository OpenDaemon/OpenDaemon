import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessInfo } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * `npm start` is a node that runs a node: stopping the app must stop both, or the grandchild
 * keeps the port. The grandchild writes its pid to a file so the test can look at it.
 */
describe.runIf(process.platform !== 'win32')('stopping an app stops everything it started', () => {
  let dir: string;
  let pm: ProcessManagerPlugin;
  const methods = new Map<string, Method>();
  const call = (m: string, p?: unknown) => methods.get(m)!(p);
  const info = async (name: string) => await call('info', { name }) as ProcessInfo;
  const pidOf = (file: string): number => Number(readFileSync(join(dir, file), 'utf-8').trim());
  async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) { if (Date.now() > end) throw new Error('condition not met'); await new Promise((r) => setTimeout(r, 25)); }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-tree-'));
    methods.clear();
    pm = new ProcessManagerPlugin();
    pm.install({
      config: {}, events: new EventBus(), logger: new Logger('tree'), store: new StateStore(),
      registerMethod: (n: string, h: Method) => { methods.set(n, h); }, getPlugin: () => undefined,
    } as unknown as PluginContext);
  });
  afterEach(async () => {
    await pm.onStop();
    for (const file of ['job1.pid', 'job2.pid']) {
      if (existsSync(join(dir, file))) { try { process.kill(pidOf(file), 'SIGKILL'); } catch { /* gone */ } }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const wrapper = (grandchildBody: string): string => {
    writeFileSync(join(dir, 'grandchild.cjs'), grandchildBody);
    const path = join(dir, 'wrapper.cjs');
    writeFileSync(path, `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [${JSON.stringify(join(dir, 'grandchild.cjs'))}], { stdio: 'inherit' });
      process.on('SIGTERM', () => {}); // like npm: it does not pass signals on
      setInterval(() => {}, 1000);
    `);
    return path;
  };

  it('stops the node a wrapper (npm start) runs, not only the wrapper', async () => {
    const body = `require('fs').writeFileSync(${JSON.stringify(join(dir, 'grandchild.pid'))}, String(process.pid)); setInterval(() => {}, 1000);`;
    await call('start', { name: 'wrapped', script: wrapper(body), killTimeout: 500 });
    await until(() => existsSync(join(dir, 'grandchild.pid')));
    const grandchild = pidOf('grandchild.pid');
    expect(alive(grandchild)).toBe(true);

    await call('stop', { name: 'wrapped' });
    await until(() => !alive(grandchild));
    expect((await info('wrapped')).status).toBe('stopped');
  });

  it('kills a grandchild that ignores SIGTERM once killTimeout is over', async () => {
    const body = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(join(dir, 'grandchild.pid'))}, String(process.pid)); setInterval(() => {}, 1000);`;
    await call('start', { name: 'stubborn', script: wrapper(body), killTimeout: 400 });
    await until(() => existsSync(join(dir, 'grandchild.pid')));
    const grandchild = pidOf('grandchild.pid');
    await call('stop', { name: 'stubborn' });
    await until(() => !alive(grandchild));
  });

  it('stops the background jobs of a shell script', async () => {
    const script = join(dir, 'jobs.sh');
    writeFileSync(script, `#!/bin/bash\nsleep 300 &\necho $! > ${join(dir, 'job1.pid')}\nsleep 301 &\necho $! > ${join(dir, 'job2.pid')}\nwait\n`);
    await call('start', { name: 'jobs', script, killTimeout: 500 });
    await until(() => existsSync(join(dir, 'job2.pid')));
    const jobs = [pidOf('job1.pid'), pidOf('job2.pid')];
    expect(jobs.every(alive)).toBe(true);
    await call('stop', { name: 'jobs' });
    await until(() => jobs.every((pid) => !alive(pid)));
  });

  it('cleans up what a process that exits by itself leaves running, before it is restarted', async () => {
    writeFileSync(join(dir, 'grandchild.cjs'), `require('fs').appendFileSync(${JSON.stringify(join(dir, 'grandchild.pid'))}, process.pid + '\\n'); setInterval(() => {}, 1000);`);
    const path = join(dir, 'dies.cjs');
    writeFileSync(path, `
      require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'grandchild.cjs'))}], { stdio: 'ignore' });
      setTimeout(() => process.exit(1), 500);
    `);
    await call('start', { name: 'dies', script: path, maxRestarts: 1, restartDelay: 50, killTimeout: 300 });
    await until(async () => (await info('dies')).restartCount >= 1);
    await until(() => readFileSync(join(dir, 'grandchild.pid'), 'utf-8').trim().split('\n').length >= 2);
    const first = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf-8').trim().split('\n')[0]);
    await until(() => !alive(first));
  }, 20000);
});
