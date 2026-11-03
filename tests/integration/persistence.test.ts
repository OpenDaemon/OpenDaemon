import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('save and resurrect', () => {
  let dir: string;
  let plugins: ProcessManagerPlugin[];
  let methods: Map<string, Method>;

  const server = (name: string): string => {
    const path = join(dir, `${name}.cjs`);
    writeFileSync(path, 'setInterval(() => {}, 1000);');
    return path;
  };
  const app = (name: string, extra: Partial<ProcessConfig> = {}): ProcessConfig =>
    ({ name, script: server(name), killTimeout: 300, ...extra });

  /** A fresh daemon: new plugin, same home directory */
  async function boot(config: object = {}): Promise<ProcessManagerPlugin> {
    methods = new Map();
    const pm = new ProcessManagerPlugin(dir);
    plugins.push(pm);
    const context = {
      config,
      events: new EventBus(),
      logger: new Logger('persistence-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: () => undefined,
    } as unknown as PluginContext;
    pm.install(context);
    await pm.onStart(context);
    return pm;
  }
  const call = (method: string, params?: unknown) => methods.get(method)!(params);
  const list = async () => await call('list') as ProcessInfo[];
  const statusOf = async (name: string) => (await list()).find((p) => p.name === name)?.status;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-save-')); plugins = []; });
  afterEach(async () => {
    for (const pm of plugins) await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('brings saved apps back when a new daemon starts', async () => {
    await boot();
    await call('start', app('web'));
    await call('start', app('worker'));
    const saved = await call('save') as { saved: string[] };
    expect(saved.saved.sort()).toEqual(['web', 'worker']);
    await plugins[0]!.onStop();

    await boot();
    expect(await statusOf('web')).toBe('online');
    expect(await statusOf('worker')).toBe('online');
  });

  it('keeps an app that was stopped when saved stopped', async () => {
    await boot();
    await call('start', app('web'));
    await call('start', app('idle'));
    await call('stop', { name: 'idle' });
    await call('save');
    await plugins[0]!.onStop();

    await boot();
    expect(await statusOf('web')).toBe('online');
    expect(await statusOf('idle')).toBe('stopped');
  });

  it('writes the file readable by the user only', async () => {
    await boot();
    await call('start', app('web'));
    const { file } = await call('save') as { file: string };
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('lets the config win over a saved app of the same name', async () => {
    await boot();
    await call('start', app('web', { args: ['saved'] }));
    await call('save');
    await plugins[0]!.onStop();

    const pm = await boot({ apps: [app('web', { args: ['configured'] })] });
    expect(pm.getProcessConfig('web')?.args).toEqual(['configured']);
  });

  it('does not resurrect when daemon.resurrect is false', async () => {
    await boot();
    await call('start', app('web'));
    await call('save');
    await plugins[0]!.onStop();

    await boot({ daemon: { resurrect: false } });
    expect(await list()).toEqual([]);
  });

  it('ignores a corrupt dump and still starts the configured apps', async () => {
    writeFileSync(join(dir, 'dump.json'), '{not json');
    await boot({ apps: [app('web')] });
    expect(await statusOf('web')).toBe('online');
  });

  it('falls back to the config when the saved apps depend on something missing', async () => {
    writeFileSync(join(dir, 'dump.json'), JSON.stringify({ processes: [{ config: app('orphan', { dependencies: ['gone'] }) }] }));
    await boot({ apps: [app('web')] });
    expect(await statusOf('web')).toBe('online');
    expect(await statusOf('orphan')).toBeUndefined();
  });

  it('resurrect starts only what is not running, and reports it', async () => {
    await boot();
    await call('start', app('web'));
    await call('start', app('worker'));
    await call('save');
    await call('stop', { name: 'worker' });

    const result = await call('resurrect') as { started: string[]; skipped: string[]; failed: string[] };
    expect(result.started).toEqual(['worker']);
    expect(result.skipped).toEqual([]);
    expect(await statusOf('worker')).toBe('online');
  });

  it('saves scheduled jobs too, and a config job of the same name is not duplicated on resurrect', async () => {
    const pm = await boot({ apps: [app('nightly', { cron: '0 3 * * *' })] });
    await call('start', app('web'));
    const { file } = await call('save') as { file: string };
    const names = (JSON.parse(readFileSync(file, 'utf-8')) as { processes: Array<{ config: ProcessConfig }> }).processes.map((p) => p.config.name);
    expect(names.sort()).toEqual(['nightly', 'web']);
    await pm.onStop();

    const registered: string[] = [];
    methods = new Map();
    const next = new ProcessManagerPlugin(dir);
    plugins.push(next);
    const events = new EventBus();
    events.on('cron:register', (data: unknown) => { registered.push((data as { config: ProcessConfig }).config.name); });
    const context = {
      config: { apps: [app('nightly', { cron: '0 3 * * *' })] }, events, logger: new Logger('persistence-test'), store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); }, getPlugin: () => undefined,
    } as unknown as PluginContext;
    next.install(context);
    await next.onStart(context);
    expect(await statusOf('web')).toBe('online');
    expect((await list()).filter((p) => p.name === 'nightly')).toHaveLength(1);
    expect(registered).toEqual([]);
  });

  it('announces a saved scheduled job to the scheduler instead of starting it', async () => {
    writeFileSync(join(dir, 'dump.json'), JSON.stringify({ processes: [{ config: app('report', { cron: '0 4 * * *' }), stopped: true }] }));
    const registered: string[] = [];
    methods = new Map();
    const pm = new ProcessManagerPlugin(dir);
    plugins.push(pm);
    const events = new EventBus();
    events.on('cron:register', (data: unknown) => { registered.push((data as { config: ProcessConfig }).config.name); });
    const context = {
      config: {}, events, logger: new Logger('persistence-test'), store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); }, getPlugin: () => undefined,
    } as unknown as PluginContext;
    pm.install(context);
    await pm.onStart(context);
    expect(registered).toEqual(['report']);
    expect(await statusOf('report')).toBe('stopped');
  });

  it('refuses to save without a home directory', async () => {
    const pm = new ProcessManagerPlugin();
    const m = new Map<string, Method>();
    pm.install({ registerMethod: (n: string, h: Method) => { m.set(n, h); } } as unknown as PluginContext);
    await expect(m.get('save')!()).rejects.toThrow(/home directory/);
    expect(existsSync(join(dir, 'dump.json'))).toBe(false);
  });
});

describe('running programs that are not Node.js scripts', () => {
  let dir: string;
  let pm: ProcessManagerPlugin;
  const methods = new Map<string, Method>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-launch-'));
    pm = new ProcessManagerPlugin();
    const context = {
      config: {}, events: new EventBus(), logger: new Logger('launch-test'), store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: () => undefined,
    } as unknown as PluginContext;
    pm.install(context);
  });
  afterEach(async () => { await pm.onStop(); rmSync(dir, { recursive: true, force: true }); });

  const logsOf = async (name: string) => ((await methods.get('logs')!({ name })) as Array<{ message: string }>).map((l) => l.message).join('\n');
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it.runIf(process.platform !== 'win32')('runs a shell script and passes its arguments', async () => {
    const script = join(dir, 'hello.sh');
    writeFileSync(script, 'echo "hello $1 from $(basename "$0")"; sleep 5');
    await methods.get('start')!({ name: 'sh', script, args: ['world'], killTimeout: 300 });
    await until(async () => (await logsOf('sh')).includes('hello'));
    expect(await logsOf('sh')).toContain('hello world from hello.sh');
  });

  it('runs a command from PATH (npm-style: script is the program, args follow)', async () => {
    await methods.get('start')!({ name: 'cmd', script: 'node', args: ['-e', 'console.log("from -e"); setInterval(() => {}, 1000)'], killTimeout: 300 });
    await until(async () => (await logsOf('cmd')).includes('from -e'));
    expect(await logsOf('cmd')).toContain('from -e');
  });

  it('runs npm, even where it is a .cmd shim (Windows)', async () => {
    await methods.get('start')!({ name: 'npmv', script: 'npm', args: ['--version'], autoRestart: false, killTimeout: 300 });
    await until(async () => /\d+\.\d+\.\d+/.test(await logsOf('npmv')));
    expect(await logsOf('npmv')).toMatch(/\d+\.\d+\.\d+/);
  });

  it('passes interpreter args to node', async () => {
    const script = join(dir, 'argv.cjs');
    writeFileSync(script, 'console.log("exec:" + process.execArgv.join(",")); setInterval(() => {}, 1000)');
    await methods.get('start')!({ name: 'flags', script, interpreterArgs: ['--no-warnings'], killTimeout: 300 });
    await until(async () => (await logsOf('flags')).includes('exec:'));
    expect(await logsOf('flags')).toContain('exec:--no-warnings');
  });

  it('refuses cluster mode for anything but a Node.js script', async () => {
    const script = join(dir, 'x.sh');
    writeFileSync(script, 'sleep 5');
    await expect(methods.get('start')!({ name: 'c', script, mode: 'cluster', instances: 2 })).rejects.toThrow(/Cluster mode runs Node.js scripts only/);
  });

  it('says so when the script or command does not exist', async () => {
    await expect(methods.get('start')!({ name: 'm', script: join(dir, 'nope.js') })).rejects.toThrow(/Script not found/);
  });
});
