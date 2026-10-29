import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, request } from 'http';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { DeployStrategyPlugin, type DeployState } from '../../packages/plugins/deploy-strategy/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, DeployConfig } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => { resolve(port); });
  });
});

describe('DeployStrategyPlugin', () => {
  let dir: string;
  let port: number;
  let pm: ProcessManagerPlugin;
  let deploy: DeployStrategyPlugin;
  let events: EventBus;
  const methods = new Map<string, Method>();

  /** A server that answers with its version; `crashAfter` makes it exit once it has been up that long */
  const release = (file: string, version: string, options: { crashAfter?: number; exitAtOnce?: boolean; failWorker?: number } = {}): string => {
    const path = join(dir, file);
    writeFileSync(path, `
      const http = require('http');
      ${options.exitAtOnce ? 'process.exit(3);' : ''}
      ${options.failWorker === undefined ? '' : `if (process.env.OD_WORKER_ID === '${String(options.failWorker)}') process.exit(3);`}
      http.createServer((req, res) => res.end(${JSON.stringify(version)} + ':' + (process.env.TAG || ''))).listen(Number(process.env.PORT), '127.0.0.1');
      ${options.crashAfter ? `setTimeout(() => process.exit(1), ${String(options.crashAfter)});` : ''}
    `);
    return path;
  };

  const get = (): Promise<string> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, agent: false, headers: { Connection: 'close' }, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => { resolve(body); });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });

  /** Versions seen in `n` requests */
  const sample = async (n = 24): Promise<Set<string>> => {
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) seen.add((await get()).split(':')[0] as string);
    return seen;
  };

  const startApp = async (script: string, settings: DeployConfig = {}, extra: Partial<ProcessConfig> = {}): Promise<void> => {
    await methods.get('start')!({
      name: 'web', script, mode: 'cluster', instances: 3, env: { PORT: String(port) },
      killTimeout: 500, restartDelay: 100, deploy: { readyTimeout: 8000, ...settings }, ...extra,
    });
    await until(async () => (await sample(6)).has('v1'));
  };

  const until = async (check: () => Promise<boolean> | boolean, ms = 10000): Promise<void> => {
    const stop = Date.now() + ms;
    for (;;) {
      try { if (await check()) return; } catch { /* not yet */ }
      if (Date.now() > stop) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const run = async (request: Record<string, unknown>): Promise<DeployState> => {
    await methods.get('deploy.execute')!(request);
    await deploy.idle();
    return methods.get('deploy.status')!({ name: 'web' }) as Promise<DeployState>;
  };

  /** Requests in a loop while `during` runs; returns how many failed */
  const failuresDuring = async (during: () => Promise<unknown>): Promise<number> => {
    let failures = 0;
    const flag = { stop: false };
    const loop = (async () => {
      while (!flag.stop) {
        try { await get(); } catch { failures++; }
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    await during();
    flag.stop = true;
    await loop;
    return failures;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'od-deploy-'));
    port = await freePort();
    methods.clear();
    events = new EventBus();
    pm = new ProcessManagerPlugin();
    deploy = new DeployStrategyPlugin();
    const context = {
      config: {}, pluginConfig: undefined, events, logger: new Logger('deploy-test'), store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: (name: string) => ({ 'process-manager': pm, 'deploy-strategy': deploy } as Record<string, unknown>)[name],
    } as unknown as PluginContext;
    pm.install(context);
    deploy.install(context);
  });

  afterEach(async () => {
    await deploy.onStop();
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should roll a cluster to a new release without dropping a request', async () => {
    await startApp(release('v1.cjs', 'v1'));
    const v2 = release('v2.cjs', 'v2');
    let state!: DeployState;
    const failures = await failuresDuring(async () => { state = await run({ name: 'web', strategy: 'rolling', release: { script: v2, version: '2' } }); });
    expect(state.state).toBe('succeeded');
    expect(state.steps.filter((s) => s.includes('switched'))).toHaveLength(3);
    expect(failures).toBe(0);
    expect([...await sample()]).toEqual(['v2']);
    expect(pm.getWorkerIndices('web')).toEqual([0, 1, 2]);
    expect(pm.getProcessConfig('web')?.script).toBe(v2);
  }, 60000);

  it('should switch a blue-green deploy only when the whole new set is ready', async () => {
    await startApp(release('v1.cjs', 'v1'), { strategy: 'blue-green', switchTimeout: 500 });
    const failures = await failuresDuring(async () => {
      const state = await run({ name: 'web', release: { script: release('v2.cjs', 'v2') } });
      expect(state.state).toBe('succeeded');
      expect(state.strategy).toBe('blue-green');
      expect(state.steps).toContain('the new set is ready: switching');
    });
    expect(failures).toBe(0);
    await until(async () => (await sample(12)).size === 1);
    expect([...await sample()]).toEqual(['v2']);
  }, 60000);

  it('should leave the old set serving when a new worker never becomes ready', async () => {
    await startApp(release('v1.cjs', 'v1'));
    const state = await run({ name: 'web', strategy: 'blue-green', release: { script: release('bad.cjs', 'bad', { exitAtOnce: true }) } });
    expect(state.state).toBe('rolled-back');
    expect(state.error).toContain('the old set is untouched');
    expect([...await sample()]).toEqual(['v1']);
    expect(pm.getProcessConfig('web')?.script).toContain('v1.cjs');
  }, 60000);

  it('should put the old release back on the workers already switched when a later one fails', async () => {
    await startApp(release('v1.cjs', 'v1'));
    // Workers 0 and 1 come up on the new release; worker 2 dies on start
    const state = await run({ name: 'web', strategy: 'rolling', release: { script: release('half.cjs', 'half', { failWorker: 2 }) } });
    expect(state.state).toBe('rolled-back');
    expect(state.steps.filter((s) => s.includes('switched'))).toHaveLength(3); // #0, #1, then both reverted together
    expect(state.steps.at(-1)).toBe('rolled back');
    await until(async () => (await sample(12)).size === 1);
    expect([...await sample()]).toEqual(['v1']);
    expect(pm.getWorkerIndices('web')).toEqual([0, 1, 2]);
  }, 60000);

  it('should stop a rolling deploy that exceeds its timeout', async () => {
    await startApp(release('v1.cjs', 'v1'), { timeout: 1 });
    const state = await run({ name: 'web', strategy: 'rolling', release: { script: release('v2.cjs', 'v2') } });
    expect(state.state).toBe('rolled-back');
    expect(state.error).toContain('exceeded its timeout');
  }, 60000);

  it('should ramp a canary and promote it when it stays healthy', async () => {
    await startApp(release('v1.cjs', 'v1'), { canarySteps: [34, 100], canaryAnalysis: { duration: 600 } });
    const state = await run({ name: 'web', strategy: 'canary', release: { script: release('v2.cjs', 'v2') } });
    expect(state.state).toBe('succeeded');
    expect(state.steps.some((s) => s.startsWith('canary step 1/2: 34% (2 of 3'))).toBe(true);
    expect(state.steps).toContain('watching the canary for 600ms');
    expect([...await sample()]).toEqual(['v2']);
  }, 60000);

  it('should abort a canary whose workers crash and put the old release back', async () => {
    await startApp(release('v1.cjs', 'v1'), { canarySteps: [34, 100], canaryAnalysis: { duration: 3000 } });
    const state = await run({ name: 'web', strategy: 'canary', release: { script: release('flaky.cjs', 'flaky', { crashAfter: 1500 }) } });
    expect(state.state).toBe('rolled-back');
    expect(state.error).toMatch(/canary worker #\d exited/);
    await until(async () => (await sample(12)).size === 1);
    expect([...await sample()]).toEqual(['v1']);
  }, 60000);

  it('should pass release environment to new workers and roll back to the previous release', async () => {
    const v1 = release('v1.cjs', 'v1');
    await startApp(v1);
    const v2 = release('v2.cjs', 'v2');
    expect((await run({ name: 'web', release: { script: v2, env: { TAG: 'blue' } } })).state).toBe('succeeded');
    expect(await get()).toBe('v2:blue');

    const rollingBack = await methods.get('deploy.rollback')!({ name: 'web' }) as DeployState;
    expect(rollingBack.state).toBe('running');
    await deploy.idle();
    expect((await methods.get('deploy.status')!({ name: 'web' }) as DeployState).state).toBe('succeeded');
    expect(await get()).toBe('v1:');
    expect(pm.getProcessConfig('web')?.script).toBe(v1);

    // and forward again: the release rolled back from becomes the previous one
    await methods.get('deploy.rollback')!({ name: 'web' });
    await deploy.idle();
    expect(await get()).toBe('v2:blue');
  }, 90000);

  it('should label releases with OD_RELEASE, keep the label across unlabelled deploys and restore it on rollback', async () => {
    const path = join(dir, 'label.cjs');
    writeFileSync(path, `require('http').createServer((q, r) => r.end('label:' + (process.env.OD_RELEASE || 'none'))).listen(Number(process.env.PORT), '127.0.0.1');`);
    await methods.get('start')!({ name: 'web', script: path, mode: 'cluster', instances: 2, env: { PORT: String(port) }, killTimeout: 500, deploy: { readyTimeout: 8000 } });
    await until(async () => (await get()) === 'label:none');
    await run({ name: 'web', release: { version: '1.0' } });
    expect(await get()).toBe('label:1.0');
    await run({ name: 'web', strategy: 'rolling' });                       // same release, workers replaced
    expect(await get()).toBe('label:1.0');
    await run({ name: 'web', release: { version: '2.0', env: { X: '1' } } });
    expect(await get()).toBe('label:2.0');
    await methods.get('deploy.rollback')!({ name: 'web' });
    await deploy.idle();
    expect(await get()).toBe('label:1.0');
  }, 60000);

  it('should apply the release to crash restarts too', async () => {
    await startApp(release('v1.cjs', 'v1'), {}, { instances: 1 });
    await run({ name: 'web', release: { script: release('v2.cjs', 'v2') } });
    expect(pm.getWorkerIndices('web')).toEqual([0]);
    const info = await methods.get('info')!({ name: 'web' }) as { pids: number[] };
    process.kill(info.pids[1] as number, 'SIGKILL');
    await until(async () => (await get()) === 'v2:');
  }, 60000);

  it('should recreate a fork-mode app, and refuse strategies that need a cluster', async () => {
    const v1 = release('v1.cjs', 'v1');
    await methods.get('start')!({ name: 'solo', script: v1, env: { PORT: String(port) }, killTimeout: 500 });
    await until(async () => (await get()).startsWith('v1'));

    expect(() => deploy.execute({ name: 'solo', strategy: 'rolling' })).toThrow('runs in fork mode');
    const state = deploy.execute({ name: 'solo', release: { script: release('v2.cjs', 'v2') } });
    expect(state.strategy).toBe('recreate');
    await deploy.idle();
    expect(state.state).toBe('succeeded');
    await until(async () => (await get()).startsWith('v2'));
  }, 60000);

  it('should validate requests', async () => {
    await startApp(release('v1.cjs', 'v1'));
    expect(() => deploy.execute({ name: 'ghost' })).toThrow('not found');
    expect(() => deploy.execute({ name: 'web', strategy: 'a-b' as never })).toThrow('needs request routing');
    expect(() => deploy.rollback('web')).toThrow('Nothing to roll back');
    deploy.execute({ name: 'web', release: { script: release('v2.cjs', 'v2') } });
    expect(() => deploy.execute({ name: 'web' })).toThrow('already running');
    await deploy.idle();
    expect(await methods.get('deploy.status')!({}) as DeployState[]).toHaveLength(1);
    expect(await methods.get('deploy.status')!({ name: 'ghost' })).toBeNull();
  }, 60000);

  it('should announce deploys', async () => {
    const seen: string[] = [];
    for (const e of ['deploy:started', 'deploy:succeeded', 'deploy:failed']) events.on(e, () => { seen.push(e); });
    await startApp(release('v1.cjs', 'v1'));
    await run({ name: 'web', release: { script: release('v2.cjs', 'v2') } });
    await run({ name: 'web', strategy: 'blue-green', release: { script: release('bad.cjs', 'bad', { exitAtOnce: true }) } });
    expect(seen).toEqual(['deploy:started', 'deploy:succeeded', 'deploy:started', 'deploy:failed']);
  }, 60000);

  it('should reject invalid deploy settings when starting an app', async () => {
    const script = release('v1.cjs', 'v1');
    await expect(methods.get('start')!({ name: 'a', script, deploy: { strategy: 'yolo' } })).rejects.toThrow('Invalid deploy strategy');
    await expect(methods.get('start')!({ name: 'a', script, deploy: { canarySteps: [10, 150] } })).rejects.toThrow('Invalid deploy settings');
    await expect(methods.get('start')!({ name: 'a', script, deploy: { maxSurge: 0 } })).rejects.toThrow('Invalid deploy settings');
  });
});
