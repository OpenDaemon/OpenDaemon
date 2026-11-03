import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChildRegistry, processIdentity } from '../../packages/plugins/process-manager/src/orphans.js';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessInfo } from '../../packages/core/src/index.js';

const posix = process.platform !== 'win32';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('condition not met'); await new Promise((r) => setTimeout(r, 25)); }
}

describe.runIf(posix)('processes left behind by a killed daemon', () => {
  let dir: string;
  const spawned: ChildProcess[] = [];
  /** A process that outlives its parent's interest, like a child of a daemon that was killed */
  const sleeper = (): ChildProcess => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    child.unref();
    spawned.push(child);
    return child;
  };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-orphans-')); });
  afterEach(() => {
    for (const child of spawned.splice(0)) { try { process.kill(child.pid as number, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells a process from a later one with the same pid, and knows when one is gone', async () => {
    const child = sleeper();
    const first = processIdentity(child.pid as number);
    expect(first).toBeDefined();
    expect(processIdentity(child.pid as number)).toBe(first);
    expect(processIdentity(process.pid)).not.toBe(first);
    process.kill(child.pid as number, 'SIGKILL');
    await until(() => processIdentity(child.pid as number) === undefined);
  });

  it('stops what a previous registry lists, and only that', async () => {
    const file = join(dir, 'children.json');
    const orphan = sleeper();
    const bystander = sleeper();
    const before = new ChildRegistry(file);
    before.add(orphan.pid as number, 'web');
    // a pid that now belongs to something else: the recorded identity does not match
    writeFileSync(file, JSON.stringify({
      ...(JSON.parse(readFileSync(file, 'utf-8')) as object),
      [String(bystander.pid)]: { name: 'reused-pid', identity: 'not-its-start-time' },
      '999999': { name: 'gone', identity: '1' },
    }));

    const stopped = await new ChildRegistry(file).reap(1000);
    expect(stopped).toEqual(['web']);
    await until(() => !alive(orphan.pid as number));
    expect(alive(bystander.pid as number)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('kills a process that ignores SIGTERM once the grace period is over', async () => {
    const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore', detached: true });
    stubborn.unref();
    spawned.push(stubborn);
    await new Promise((r) => setTimeout(r, 300));
    const registry = new ChildRegistry(join(dir, 'children.json'));
    registry.add(stubborn.pid as number, 'stubborn');
    await new ChildRegistry(join(dir, 'children.json')).reap(400);
    await until(() => !alive(stubborn.pid as number));
  });

  it('ignores a registry that cannot be read, and does nothing without one', async () => {
    expect(await new ChildRegistry(join(dir, 'none.json')).reap()).toEqual([]);
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(await new ChildRegistry(join(dir, 'bad.json')).reap()).toEqual([]);
    expect(existsSync(join(dir, 'bad.json'))).toBe(false);
  });

  it('is what a new process manager runs first: the old process is stopped before apps start', async () => {
    const orphan = sleeper();
    new ChildRegistry(join(dir, 'children.json')).add(orphan.pid as number, 'old');

    const methods = new Map<string, (p?: unknown) => Promise<unknown>>();
    const pm = new ProcessManagerPlugin(dir);
    const context = {
      config: {}, events: new EventBus(), logger: new Logger('orphans'), store: new StateStore(),
      registerMethod: (n: string, h: (p?: unknown) => Promise<unknown>) => { methods.set(n, h); }, getPlugin: () => undefined,
    } as unknown as PluginContext;
    pm.install(context);
    try {
      await pm.onStart(context);
      expect(alive(orphan.pid as number)).toBe(false);

      // children of this daemon are registered while they run, and forgotten when stopped
      const script = join(dir, 'app.cjs');
      writeFileSync(script, 'setInterval(() => {}, 1000)');
      const info = await methods.get('start')!({ name: 'app', script, killTimeout: 300 }) as ProcessInfo;
      const registry = JSON.parse(readFileSync(join(dir, 'children.json'), 'utf-8')) as Record<string, { name: string }>;
      expect(registry[String(info.pid)]?.name).toBe('app');
      await methods.get('stop')!({ name: 'app' });
      await until(() => !(String(info.pid) in (JSON.parse(readFileSync(join(dir, 'children.json'), 'utf-8')) as object)));
    } finally {
      await pm.onStop();
    }
    expect(existsSync(join(dir, 'children.json'))).toBe(false);
  });
});
