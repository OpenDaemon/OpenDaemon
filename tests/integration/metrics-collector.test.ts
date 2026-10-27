import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, cpus } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { MetricsCollectorPlugin } from '../../packages/plugins/metrics-collector/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('MetricsCollectorPlugin with the process manager', () => {
  let dir: string;
  let pm: ProcessManagerPlugin;
  let collector: MetricsCollectorPlugin;
  const methods = new Map<string, Method>();

  /** An app that reports what the SDK runtime would, on the same IPC channel */
  const reportingApp = () => {
    const path = join(dir, 'app.cjs');
    writeFileSync(path, [
      "const id = process.env.OD_WORKER_ID ?? 'fork';",
      'const report = () => process.send({ type: "od:metrics", metrics: [',
      "  { name: 'jobs_total', type: 'counter', help: 'Jobs done', series: [{ labels: { worker: id }, value: 7 }] },",
      ']});',
      'report();',
      'setInterval(report, 100);',
    ].join('\n'));
    return path;
  };

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-metrics-'));
    methods.clear();
    pm = new ProcessManagerPlugin();
    collector = new MetricsCollectorPlugin();
    const context = {
      config: {},
      pluginConfig: undefined,
      events: new EventBus(),
      logger: new Logger('metrics-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      registerHook: () => {},
      getPlugin: (name: string) => (name === 'process-manager' ? pm : undefined),
      registerMetric: () => {},
    } as unknown as PluginContext;
    pm.install(context);
    collector.install(context);
  });

  afterEach(async () => {
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should report host metrics with sane values', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const { system } = collector.collect();
    expect(system.cpu.cores).toHaveLength(cpus().length);
    expect(system.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(system.cpu.percent).toBeLessThanOrEqual(100);
    expect(system.memory.used).toBe(system.memory.total - system.memory.free);
    expect(system.loadavg).toHaveLength(3);
  });

  it('should include app metrics from a forked process and drop them once it stops', async () => {
    await methods.get('start')!({ name: 'app', script: reportingApp(), killTimeout: 300 });
    await waitFor(() => collector.collect().processes[0]?.custom.length === 1);

    const [proc] = collector.collect().processes;
    expect(proc).toMatchObject({ name: 'app', status: 'online', restarts: 0 });
    expect(proc?.custom[0]).toEqual({ metrics: [expect.objectContaining({ name: 'jobs_total' })] });
    expect(await methods.get('metrics')!({ format: 'prometheus' })).toContain('jobs_total{worker="fork",process="app"} 7');

    await methods.get('stop')!({ name: 'app' });
    expect(collector.collect().processes[0]?.custom).toEqual([]);
  });

  it('should label app metrics from cluster workers by instance', async () => {
    await methods.get('start')!({ name: 'app', script: reportingApp(), mode: 'cluster', instances: 2, killTimeout: 300 });
    await waitFor(() => collector.collect().processes[0]?.custom.length === 2);

    const text = collector.prometheus();
    expect(text).toContain('jobs_total{worker="0",process="app",instance="0"} 7');
    expect(text).toContain('jobs_total{worker="1",process="app",instance="1"} 7');
    expect(text).toContain('od_process_instances{process="app"} 2');
  });

  it('should return the JSON report by default over RPC', async () => {
    const report = await methods.get('metrics')!({}) as { system: unknown; processes: unknown[] };
    expect(report.processes).toEqual([]);
    expect(report.system).toBeDefined();
  });
});
