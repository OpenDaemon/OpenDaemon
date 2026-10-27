import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { SchedulerPlugin, type CronJobReport } from '../../packages/plugins/scheduler/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('SchedulerPlugin with the process manager', () => {
  let dir: string;
  let pm: ProcessManagerPlugin;
  let scheduler: SchedulerPlugin;
  let context: PluginContext;
  const methods = new Map<string, Method>();

  const script = (name: string, body: string) => {
    const path = join(dir, `${name}.cjs`);
    writeFileSync(path, body);
    return path;
  };
  const job = (name: string, body: string, extra: Partial<ProcessConfig> = {}): ProcessConfig =>
    ({ name, script: script(name, body), cron: '* * * * * *', killTimeout: 300, ...extra });
  const report = () => scheduler.report()[0] as CronJobReport;
  const info = async (name: string) => await methods.get('info')!({ name }) as ProcessInfo;

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(scheduler.report())}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function boot(apps: ProcessConfig[]): Promise<void> {
    const ctx = { ...context, config: { apps } } as PluginContext;
    await pm.onStart(ctx);
    scheduler.onStart(ctx);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-cron-'));
    methods.clear();
    pm = new ProcessManagerPlugin();
    scheduler = new SchedulerPlugin();
    context = {
      config: {},
      events: new EventBus(),
      logger: new Logger('cron-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: (name: string) => (name === 'process-manager' ? pm : undefined),
    } as unknown as PluginContext;
    pm.install(context);
    scheduler.install(context);
  });

  afterEach(async () => {
    scheduler.onStop();
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should not start a cron app with the daemon, then run it at each tick', async () => {
    await boot([job('cleanup', 'process.exit(0);', { autoRestart: true })]);
    expect(await info('cleanup')).toMatchObject({ status: 'stopped', errorMessage: 'scheduled: cron "* * * * * *"' });
    expect(report().nextRun).toBeDefined();

    await waitFor(() => report().history.filter((r) => r.result === 'succeeded').length >= 2);
    expect(report().history[0]).toMatchObject({ attempt: 1, result: 'succeeded', exitCode: 0 });
    // autoRestart from the app config is overridden: the run ends instead of looping
    expect((await info('cleanup')).restartCount).toBe(0);
    expect(await methods.get('cron')!()).toEqual(scheduler.report());
  });

  it('should skip a tick while the previous run is still active', async () => {
    await boot([job('slow', 'setInterval(() => {}, 1000);')]);
    await waitFor(() => report().history.some((r) => r.result === 'skipped'));

    const [first] = report().history;
    expect(first?.result).toBe('running');
    expect((await info('slow')).status).toBe('online');
  });

  it('should replace the running instance on overlap when cronOverlap is set', async () => {
    await boot([job('replace', 'setInterval(() => {}, 1000);', { cronOverlap: true })]);
    await waitFor(async () => (await info('replace')).status === 'online');
    const firstPid = (await info('replace')).pid;

    await waitFor(async () => (await info('replace')).pid !== firstPid && (await info('replace')).status === 'online');
    const results = report().history.map((r) => r.result);
    expect(results[0]).toBe('stopped');
    expect(results.at(-1)).toBe('running');
    expect(results).not.toContain('skipped');
  });

  it('should retry a failed run up to cronRetry times', async () => {
    // A schedule that cannot fire during the test; trigger the tick by hand
    await boot([job('flaky', 'process.exit(3);', { cronRetry: 2, restartDelay: 50, cron: '0 0 1 1 *' })]);
    (scheduler as unknown as { tick(job: unknown): void }).tick((scheduler as unknown as { jobs: Map<string, unknown> }).jobs.get('flaky'));

    await waitFor(() => report().history.filter((r) => r.result === 'failed').length === 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(report().history.map((r) => [r.attempt, r.result, r.exitCode])).toEqual([
      [1, 'failed', 3], [2, 'failed', 3], [3, 'failed', 3],
    ]);
  });

  it('should record a run stopped by the user', async () => {
    await boot([job('manual', 'setInterval(() => {}, 1000);')]);
    await waitFor(async () => (await info('manual')).status === 'online');
    await methods.get('stop')!({ name: 'manual' });
    expect(report().history[0]?.result).toBe('stopped');
  });
});
