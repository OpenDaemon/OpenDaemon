/**
 * End-to-end: the programmatic client (`opendaemon/client`, PM2's require('pm2')) against a real
 * daemon, loaded the way a user's script would: as ESM and as CommonJS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const CLI = resolve('packages/cli/dist/cli.js');
const CLIENT_ESM = resolve('packages/client/dist/index.js');
const CLIENT_CJS = resolve('packages/client/dist/index.cjs');

type Client = typeof import('../../packages/cli/src/api.js');

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!existsSync(CLI) || !existsSync(CLIENT_ESM))('programmatic client end to end', () => {
  let root: string;
  let home: string;
  let project: string;
  let OpenDaemon: Client['OpenDaemon'];
  const saved = process.env['OPENDAEMON_HOME'];

  beforeAll(async () => {
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-client-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(project);
    process.env['OPENDAEMON_HOME'] = home;
    writeFileSync(join(project, 'app.cjs'), "console.log('app up mode=' + process.env.MODE); process.on('SIGUSR2', () => console.log('got usr2')); setInterval(() => {}, 1000);");
    writeFileSync(join(project, 'clu.cjs'), "console.log('clu ' + process.env.GREETING); setInterval(() => {}, 1000);");
    OpenDaemon = ((await import(pathToFileURL(CLIENT_ESM).href)) as Client).OpenDaemon;
  });
  afterAll(() => {
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: { ...process.env, OPENDAEMON_HOME: home } });
    if (saved === undefined) delete process.env['OPENDAEMON_HOME']; else process.env['OPENDAEMON_HOME'] = saved;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp dir */ }
  });

  it('says how to start the daemon when none is running', async () => {
    await expect(OpenDaemon.connect()).rejects.toThrow(/Cannot reach the OpenDaemon daemon.*od daemon start/);
  });

  it('manages processes the way a script would', async () => {
    expect(spawnSync(process.execPath, [CLI, 'daemon', 'start'], { env: { ...process.env, OPENDAEMON_HOME: home } }).status).toBe(0);
    const od = await OpenDaemon.connect();
    try {
      expect((await od.status()).status).toBeDefined();
      expect(await od.list()).toEqual([]);

      const started = await od.start({ name: 'app', script: join(project, 'app.cjs'), env: { MODE: 'one' }, killTimeout: 500 });
      expect(started).toMatchObject({ name: 'app', status: 'online' });
      await expect(od.start({ name: 'app', script: join(project, 'app.cjs') })).rejects.toThrow(/already exists/);
      expect((await od.describe('app'))?.status).toBe('online');
      expect(await od.describe('nope')).toBeNull();
      expect(await od.env('app')).toEqual({ MODE: 'one' });

      await waitFor(async () => (await od.logs({ name: 'app' })).some((l) => l.message === 'app up mode=one'));
      expect((await od.logs({ name: 'app', source: 'stderr' })).length).toBe(0);

      const seen: string[] = [];
      await od.follow({ name: 'app' }, (entry) => { seen.push(entry.message); });
      if (process.platform !== 'win32') {
        expect((await od.signal('app', 'SIGUSR2')).length).toBe(1);
        await waitFor(() => seen.includes('got usr2'));
      }

      const before = (await od.describe('app'))?.pid;
      await od.restart('app', { env: { MODE: 'two' } });
      await waitFor(async () => (await od.describe('app'))?.pid !== before);
      await waitFor(async () => (await od.logs({ name: 'app' })).some((l) => l.message === 'app up mode=two'));
      expect(await od.env('app')).toEqual({ MODE: 'two' });
      expect(await od.reset('app')).toEqual(['app']);

      // start or replace: the running app takes the new settings
      await od.startOrRestart({ name: 'app', script: join(project, 'app.cjs'), env: { MODE: 'three' }, killTimeout: 500 });
      await waitFor(async () => (await od.logs({ name: 'app' })).some((l) => l.message === 'app up mode=three'));

      expect((await od.save()).saved).toEqual(['app']);
      expect(await od.stop('app')).toEqual(['app']);
      expect((await od.describe('app'))?.status).toBe('stopped');
      expect((await od.resurrect()).started).toEqual(['app']);
      expect(typeof (await od.metrics('prometheus'))).toBe('string');
      await od.delete('app');
      expect(await od.describe('app')).toBeNull();
    } finally {
      await od.disconnect();
    }
  });

  it('scales and reloads a cluster app without downtime, with a new release', async () => {
    const od = await OpenDaemon.connect();
    try {
      await od.start({ name: 'clu', script: join(project, 'clu.cjs'), mode: 'cluster', instances: 2, env: { GREETING: 'hello' }, killTimeout: 500 });
      await waitFor(async () => (await od.logs({ name: 'clu' })).filter((l) => l.message === 'clu hello').length >= 2);
      expect((await od.scale('clu', 3)).instances).toBe(3);
      await waitFor(async () => (await od.logs({ name: 'clu' })).filter((l) => l.message === 'clu hello').length >= 3);
      const state = await od.reload('clu', { env: { GREETING: 'bye' } });
      expect(state.state).toBe('succeeded');
      await waitFor(async () => (await od.logs({ name: 'clu' })).filter((l) => l.message === 'clu bye').length >= 3);
      await expect(od.reload('ghost')).rejects.toThrow();
    } finally {
      await od.disconnect();
    }
  });

  it('also loads as CommonJS', async () => {
    const mod = createRequire(import.meta.url)(CLIENT_CJS) as Client;
    const od = await mod.OpenDaemon.connect();
    expect(Array.isArray(await od.list())).toBe(true);
    expect(await od.call('daemon.status')).toHaveProperty('pid');
    await od.disconnect();
  });
});
