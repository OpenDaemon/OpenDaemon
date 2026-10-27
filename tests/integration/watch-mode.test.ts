import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { WatchModePlugin, compileIgnore } from '../../packages/plugins/watch-mode/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo } from '../../packages/core/src/index.js';

describe('compileIgnore', () => {
  const ignored = compileIgnore(['node_modules', '*.test.ts', 'src/generated/**', 'build/', '?.tmp']);

  it.each([
    ['node_modules/x/index.js', true],
    ['packages/a/node_modules/y.js', true],
    ['src/app.test.ts', true],
    ['src/app.ts', false],
    ['src/generated/types.ts', true],
    ['src/generated/deep/x.ts', true],
    ['lib/src/generated/x.ts', false],
    ['build/out.js', true],
    ['a.tmp', true],
    ['ab.tmp', false],
    [`src${sep}generated${sep}win.ts`, true],
  ])('%s -> %s', (path, expected) => {
    expect(ignored(path)).toBe(expected);
  });
});

type Method = (params?: unknown) => Promise<unknown>;

describe('WatchModePlugin with the process manager', () => {
  let dir: string;
  let events: EventBus;
  let pm: ProcessManagerPlugin;
  let watcher: WatchModePlugin;
  const methods = new Map<string, Method>();
  const changes: Array<{ name: string; files: string[] }> = [];

  const info = async () => await methods.get('info')!({ name: 'app' }) as ProcessInfo;
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('condition not met');
      await settle(25);
    }
  }

  async function start(extra: Partial<ProcessConfig>): Promise<ProcessInfo> {
    // Let the filesystem settle so watchers do not see the fixture writes (FSEvents on macOS)
    await settle(300);
    const started = await methods.get('start')!({ name: 'app', script: join(dir, 'app.cjs'), killTimeout: 300, ...extra }) as ProcessInfo;
    await settle(200);
    return started;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-watch-'));
    writeFileSync(join(dir, 'app.cjs'), 'setInterval(() => {}, 1000);');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'src', 'lib.js'), '1');

    events = new EventBus();
    changes.length = 0;
    events.on('watch:change', (d: unknown) => { changes.push(d as (typeof changes)[number]); });
    methods.clear();
    pm = new ProcessManagerPlugin();
    watcher = new WatchModePlugin();
    const context = {
      config: { daemon: { logDir: join(dir, 'logs') } },
      events,
      logger: new Logger('watch-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: (name: string) => (name === 'process-manager' ? pm : undefined),
    } as unknown as PluginContext;
    pm.install(context);
    watcher.install(context);
  });

  afterEach(async () => {
    watcher.onStop();
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should restart once after a burst of changes in a watched subdirectory', async () => {
    const first = await start({ watch: { delay: 150 } });
    expect(watcher.watching()).toEqual(['app']);

    writeFileSync(join(dir, 'src', 'lib.js'), '2');
    writeFileSync(join(dir, 'src', 'other.js'), '3');
    await waitFor(async () => (await info()).pid !== first.pid && (await info()).status === 'online');
    await settle(400);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.files.some((f) => f.endsWith('lib.js'))).toBe(true);
    // Restarting re-arms the watchers
    expect(watcher.watching()).toEqual(['app']);
  });

  it('should ignore node_modules, log files, the daemon log dir and custom patterns', async () => {
    const first = await start({ watch: { delay: 100, ignore: ['*.tmp'] } });

    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'x');
    writeFileSync(join(dir, 'debug.log'), 'x');
    writeFileSync(join(dir, 'logs', 'app-out.log'), 'x');
    writeFileSync(join(dir, 'src', 'scratch.tmp'), 'x');
    await settle(500);

    expect(changes).toEqual([]);
    expect((await info()).pid).toBe(first.pid);
  });

  it('should watch only the configured paths', async () => {
    const first = await start({ watch: { paths: ['./src'], delay: 100 } });

    writeFileSync(join(dir, 'outside.js'), 'x');
    await settle(400);
    expect(changes).toEqual([]);

    writeFileSync(join(dir, 'src', 'lib.js'), 'changed');
    await waitFor(async () => (await info()).pid !== first.pid);
  });

  it('should stop watching when the process is stopped', async () => {
    await start({ watch: { delay: 100 } });
    await methods.get('stop')!({ name: 'app' });
    expect(watcher.watching()).toEqual([]);

    writeFileSync(join(dir, 'src', 'lib.js'), 'changed');
    await settle(400);
    expect(changes).toEqual([]);
    expect((await info()).status).toBe('stopped');
  });

  it('should not watch processes without watch enabled', async () => {
    await start({});
    expect(watcher.watching()).toEqual([]);
  });
});
