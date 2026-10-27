import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { HealthCheckPlugin, type HealthReport } from '../../packages/plugins/health-check/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo, HealthCheckConfig } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('HealthCheckPlugin with the process manager', () => {
  let dir: string;
  let flag: string;
  let events: EventBus;
  let pm: ProcessManagerPlugin;
  let health: HealthCheckPlugin;
  const methods = new Map<string, Method>();
  const seen: string[] = [];

  /** Passes while the flag file is absent; creating it makes the app "unhealthy" */
  const flagCheck = (overrides: Partial<HealthCheckConfig> = {}): HealthCheckConfig => ({
    type: 'script',
    command: process.execPath,
    args: ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 1 : 0)`],
    interval: 100,
    failureThreshold: 2,
    ...overrides,
  });

  const start = (healthCheck: HealthCheckConfig, extra: Partial<ProcessConfig> = {}) =>
    methods.get('start')!({ name: 'app', script: join(dir, 'app.js'), killTimeout: 500, healthCheck, ...extra }) as Promise<ProcessInfo>;
  const info = () => methods.get('info')!({ name: 'app' }) as Promise<ProcessInfo>;
  const report = async () => ((await methods.get('health')!({ name: 'app' })) as HealthReport[])[0];

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms; events: ${seen.join(', ')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-health-'));
    flag = join(dir, 'unhealthy');
    writeFileSync(join(dir, 'app.js'), 'setInterval(() => {}, 1000);');

    events = new EventBus();
    seen.length = 0;
    // Wildcard handlers receive only the payload, so record each event name explicitly
    for (const event of [
      'health:check:start', 'health:check:pass', 'health:check:fail', 'health:status:healthy',
      'health:status:unhealthy', 'health:action:restart', 'health:action:stop',
    ]) {
      events.on(event, () => { seen.push(event); });
    }
    methods.clear();
    pm = new ProcessManagerPlugin();
    health = new HealthCheckPlugin();

    const context = {
      config: {},
      pluginConfig: undefined,
      events,
      logger: new Logger('health-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      registerHook: () => {},
      getPlugin: (name: string) => (name === 'process-manager' ? pm : undefined),
      registerMetric: () => {},
    } as unknown as PluginContext;

    pm.install(context);
    health.install(context);
    health.onStart();
  });

  afterEach(async () => {
    health.onStop();
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should mark a passing process healthy', async () => {
    await start(flagCheck());
    await waitFor(async () => (await report())?.status === 'healthy');
    expect(seen).toContain('health:check:pass');
    expect((await report())?.lastResult?.message).toBe('exit 0');
  });

  it('should restart a process after failureThreshold consecutive failures', async () => {
    const first = await start(flagCheck());
    await waitFor(async () => (await report())?.status === 'healthy');

    writeFileSync(flag, '');
    await waitFor(() => seen.includes('health:action:restart'));
    rmSync(flag);

    await waitFor(async () => {
      const now = await info();
      return now.status === 'online' && now.pid !== first.pid;
    });
    expect(seen.filter((e) => e === 'health:check:fail').length).toBeGreaterThanOrEqual(2);
    expect(seen).toContain('health:status:unhealthy');
    // The restarted process gets a fresh monitor that becomes healthy again
    await waitFor(async () => (await report())?.status === 'healthy');
  });

  it('should stop a process when action is "stop"', async () => {
    writeFileSync(flag, '');
    await start(flagCheck({ action: 'stop' }));

    await waitFor(async () => (await info()).status === 'stopped');
    expect(seen).toContain('health:action:stop');
    expect(await report()).toBeUndefined();
  });

  it('should only report with action "notify" and recover when checks pass again', async () => {
    const first = await start(flagCheck({ action: 'notify' }));
    writeFileSync(flag, '');
    await waitFor(async () => (await report())?.status === 'unhealthy');
    expect((await info()).pid).toBe(first.pid);

    rmSync(flag);
    await waitFor(async () => (await report())?.status === 'healthy');
    expect(seen).not.toContain('health:action:restart');
  });

  it('should wait initialDelay before the first check', async () => {
    await start(flagCheck({ initialDelay: 400 }));
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).not.toContain('health:check:start');
    await waitFor(() => seen.includes('health:check:start'));
  });

  it('should not monitor processes with an invalid or missing health check', async () => {
    await start({ type: 'tcp' });
    expect(await report()).toBeUndefined();

    await methods.get('stop')!({ name: 'app' });
    await methods.get('delete')!({ name: 'app' });
    await methods.get('start')!({ name: 'app', script: join(dir, 'app.js'), killTimeout: 500 });
    expect(await report()).toBeUndefined();
  });

  it('should pick up processes that were already online when it started', async () => {
    health.onStop();
    health = new HealthCheckPlugin();
    await start(flagCheck());

    // A plugin instance that never saw process:started finds the process in onStart
    health.install({
      events: new EventBus(),
      logger: new Logger('health-test'),
      registerMethod: () => {},
      getPlugin: () => pm,
    } as unknown as PluginContext);
    health.onStart();
    expect(health.getReports().map((r) => r.name)).toEqual(['app']);
  });
});
