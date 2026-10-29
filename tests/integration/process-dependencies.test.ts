import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('process dependencies', () => {
  let dir: string;
  let script: string;
  let events: EventBus;
  let pm: ProcessManagerPlugin;
  const methods = new Map<string, Method>();
  const health = new Map<string, string>();
  const started: string[] = [];
  const stopped: string[] = [];

  const app = (name: string, extra: Partial<ProcessConfig> = {}): ProcessConfig =>
    ({ name, script, killTimeout: 300, ...extra });
  const info = async (name: string) => await methods.get('info')!({ name }) as ProcessInfo | null;

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`condition not met; started: ${started.join(',')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function startWith(apps: ProcessConfig[]): Promise<void> {
    return pm.onStart({ config: { apps } } as unknown as PluginContext);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-deps-'));
    script = join(dir, 'app.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);');
    events = new EventBus();
    started.length = 0;
    stopped.length = 0;
    health.clear();
    events.on('process:started', (d: unknown) => { started.push((d as { name: string }).name); });
    events.on('process:stopped', (d: unknown) => { stopped.push((d as { name: string }).name); });
    methods.clear();
    pm = new ProcessManagerPlugin();
    pm.install({
      config: {},
      events,
      logger: new Logger('deps-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: (name: string) => (name === 'health-check'
        ? { getReports: (n?: string) => (n !== undefined && health.has(n) ? [{ status: health.get(n) }] : []) }
        : undefined),
    } as unknown as PluginContext);
  });

  afterEach(async () => {
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should start dependencies first and dependents in the background', async () => {
    await startWith([
      app('gateway', { dependencies: ['api'] }),
      app('api', { dependencies: ['database'] }),
      app('database'),
    ]);
    // onStart only waited for the independent app
    expect(started).toEqual(['database']);
    expect((await info('gateway'))?.status).toBe('waiting');
    expect((await info('gateway'))?.errorMessage).toBe('waiting for api');

    await waitFor(() => started.length === 3);
    expect(started).toEqual(['database', 'api', 'gateway']);
    expect((await info('gateway'))?.errorMessage).toBeUndefined();
  });

  it('should wait for a dependency with a health check to be healthy', async () => {
    await startWith([
      app('db', { healthCheck: { type: 'process' } }),
      app('api', { dependencies: ['db'] }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(started).toEqual(['db']);
    expect((await info('api'))?.status).toBe('waiting');

    health.set('db', 'healthy');
    await waitFor(() => started.includes('api'));
  });

  it('should mark dependents errored, with the reason, when a dependency cannot start', async () => {
    await startWith([
      app('db', { script: join(dir, 'missing.js') }),
      app('api', { dependencies: ['db'] }),
      app('gateway', { dependencies: ['api'] }),
    ]);
    await waitFor(async () => (await info('gateway'))?.status === 'errored');
    expect(await info('api')).toMatchObject({ status: 'errored', errorMessage: 'dependency "db" did not become ready' });
    expect(started).toEqual([]);
  });

  it('should give up after dependencyTimeout', async () => {
    await startWith([
      app('db', { healthCheck: { type: 'process' } }),
      app('api', { dependencies: ['db'], dependencyTimeout: 200 }),
    ]);
    await waitFor(async () => (await info('api'))?.status === 'errored');
    expect(started).toEqual(['db']);
  });

  it('should not start an app that was stopped while it waited', async () => {
    await startWith([
      app('db', { healthCheck: { type: 'process' } }),
      app('api', { dependencies: ['db'] }),
    ]);
    await methods.get('stop')!({ name: 'api' });
    health.set('db', 'healthy');
    await new Promise((r) => setTimeout(r, 400));
    expect(started).toEqual(['db']);
    expect((await info('api'))?.status).toBe('stopped');
  });

  it('should refuse to start anything when the graph is invalid', async () => {
    await startWith([app('a', { dependencies: ['b'] }), app('b', { dependencies: ['a'] })]);
    expect(started).toEqual([]);
    expect(await methods.get('list')!()).toEqual([]);
  });

  it('should stop dependents before their dependencies, and ad-hoc processes first', async () => {
    await startWith([app('db'), app('api', { dependencies: ['db'] }), app('gateway', { dependencies: ['api'] })]);
    await waitFor(() => started.length === 3);
    await methods.get('start')!(app('adhoc'));

    await pm.onStop();
    expect(stopped).toEqual(['adhoc', 'gateway', 'api', 'db']);
  });

  describe('cascade', () => {
    const chain = (): ProcessConfig[] => [
      app('gateway', { dependencies: ['api'] }),
      app('api', { dependencies: ['database'] }),
      app('database'),
      app('other'),
    ];

    it('should stop dependents before what they depend on, and leave unrelated apps running', async () => {
      await startWith(chain());
      await waitFor(() => started.length === 4);
      stopped.length = 0;

      expect(await methods.get('stop')!({ name: 'database', cascade: true })).toEqual(['gateway', 'api', 'database']);
      expect(stopped).toEqual(['gateway', 'api', 'database']);
      expect((await info('other'))?.status).toBe('online');
    });

    it('should stop only the app itself without cascade', async () => {
      await startWith(chain());
      await waitFor(() => started.length === 4);
      stopped.length = 0;

      await methods.get('stop')!({ name: 'database' });
      expect(stopped).toEqual(['database']);
      expect((await info('api'))?.status).toBe('online');
    });

    it('should restart the dependents in dependency order once their dependency is ready', async () => {
      await startWith(chain());
      await waitFor(() => started.length === 4);
      stopped.length = 0;
      started.length = 0;

      await methods.get('restart')!({ name: 'database', cascade: true });
      expect(stopped).toEqual(['gateway', 'api', 'database']);
      expect(started).toEqual(['database', 'api', 'gateway']);
      expect((await info('gateway'))?.status).toBe('online');
    });

    it('should leave a dependent that was already stopped alone', async () => {
      await startWith([...chain().slice(0, 3), app('late', { dependencies: ['database'], dependencyTimeout: 200 })]);
      await waitFor(() => started.length === 4);
      await methods.get('stop')!({ name: 'gateway' });
      started.length = 0;

      await methods.get('restart')!({ name: 'database', cascade: true });
      expect(started[0]).toBe('database');
      expect([...started].sort()).toEqual(['api', 'database', 'late']);
      expect((await info('gateway'))?.status).toBe('stopped');
    });
  });
});
