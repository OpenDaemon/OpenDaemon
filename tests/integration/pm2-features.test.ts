import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('PM2 features of the process manager', () => {
  let dir: string;
  let pm: ProcessManagerPlugin;
  const methods = new Map<string, Method>();

  const call = (method: string, params?: unknown) => methods.get(method)!(params);
  const info = async (name: string) => await call('info', { name }) as ProcessInfo;
  const script = (name: string, body: string): string => {
    const path = join(dir, `${name}.cjs`);
    writeFileSync(path, body);
    return path;
  };
  const app = (name: string, body: string, extra: Partial<ProcessConfig> = {}): ProcessConfig =>
    ({ name, script: script(name, body), killTimeout: 300, ...extra });
  async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not met');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-pm2f-'));
    methods.clear();
    pm = new ProcessManagerPlugin();
    pm.install({
      config: {}, events: new EventBus(), logger: new Logger('pm2f'), store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: () => undefined,
    } as unknown as PluginContext);
  });
  afterEach(async () => { await pm.onStop(); rmSync(dir, { recursive: true, force: true }); });

  describe('cronRestart', () => {
    it('restarts a running process at each match, as a new process', async () => {
      await call('start', app('cr', 'setInterval(() => {}, 1000);', { cronRestart: '* * * * * *' }));
      const first = (await info('cr')).pid;
      await waitFor(async () => { const i = await info('cr'); return i.status === 'online' && i.pid !== first; });
      const second = (await info('cr')).pid;
      await waitFor(async () => { const i = await info('cr'); return i.status === 'online' && i.pid !== second; });
    });

    it('stops restarting once the process is stopped', async () => {
      await call('start', app('cs', 'setInterval(() => {}, 1000);', { cronRestart: '* * * * * *' }));
      await call('stop', { name: 'cs' });
      await new Promise((r) => setTimeout(r, 1500));
      expect((await info('cs')).status).toBe('stopped');
    });

    it('rejects an invalid expression', async () => {
      await expect(call('start', app('bad', '', { cronRestart: 'not a cron' }))).rejects.toThrow(/Invalid cronRestart for "bad"/);
    });
  });

  describe('waitReady', () => {
    it('is online only after the app sends ready', async () => {
      const started = call('start', app('slow', "setTimeout(() => process.send('ready'), 600); setInterval(() => {}, 1000);", { waitReady: true, listenTimeout: 5000 }));
      const t0 = Date.now();
      await started;
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
      expect((await info('slow')).status).toBe('online');
    });

    it('gives up waiting after listenTimeout and still starts', async () => {
      const t0 = Date.now();
      await call('start', app('never', 'setInterval(() => {}, 1000);', { waitReady: true, listenTimeout: 400 }));
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      expect((await info('never')).status).toBe('online');
    });

    it('fails the start when the app exits before it is ready', async () => {
      await expect(call('start', app('dies', 'process.exit(3);', { waitReady: true, listenTimeout: 5000 }))).rejects.toThrow(/exited before it was ready/);
    });
  });

  describe('reset', () => {
    it('zeroes the restart counter of one process or all', async () => {
      await call('start', app('flaky', "setTimeout(() => process.exit(1), 100);", { maxRestarts: 2, restartDelay: 50 }));
      await waitFor(async () => (await info('flaky')).restartCount >= 1);
      expect(await call('reset', { name: 'flaky' })).toEqual(['flaky']);
      expect((await info('flaky')).restartCount).toBe(0);
      await waitFor(async () => (await info('flaky')).restartCount >= 1);
      expect(await call('reset')).toEqual(['flaky']);
      expect((await info('flaky')).restartCount).toBe(0);
      await expect(call('reset', { name: 'nope' })).rejects.toThrow(/not found/);
    });
  });

  describe('signal', () => {
    it.runIf(process.platform !== 'win32')('delivers a signal the app can handle', async () => {
      await call('start', app('sig', "process.on('SIGUSR2', () => { console.log('got usr2'); }); setInterval(() => {}, 1000);"));
      const logs = async () => ((await call('logs', { name: 'sig' })) as Array<{ message: string }>).map((l) => l.message).join('\n');
      await new Promise((r) => setTimeout(r, 300));
      const pids = await call('signal', { name: 'sig', signal: 'usr2' }) as number[];
      expect(pids).toHaveLength(1);
      await waitFor(async () => (await logs()).includes('got usr2'));
    });

    it('rejects unknown signals, unknown and stopped processes', async () => {
      await call('start', app('sig2', 'setInterval(() => {}, 1000);'));
      await expect(call('signal', { name: 'sig2', signal: 'NOPE' })).rejects.toThrow(/Unknown signal/);
      await expect(call('signal', { name: 'ghost', signal: 'HUP' })).rejects.toThrow(/not found/);
      await call('stop', { name: 'sig2' });
      await expect(call('signal', { name: 'sig2', signal: 'HUP' })).rejects.toThrow(/not online/);
    });
  });
});
