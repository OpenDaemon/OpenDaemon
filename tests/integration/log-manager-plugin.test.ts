import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LogManagerPlugin } from '../../packages/plugins/log-manager/src/index.js';
import { EventBus, StateStore, Logger, decodeFrames } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessLogEntry, ProcessConfig } from '../../packages/core/src/index.js';
import type { IpcSocket } from '../../packages/core/src/ipc/types.js';

type Method = (params?: unknown, socket?: IpcSocket) => Promise<unknown>;

/** Minimal IpcSocket that records written notifications and can be closed */
function fakeSocket(): IpcSocket & { received: ProcessLogEntry[]; close(): void } {
  const closeHandlers: Array<() => void> = [];
  const received: ProcessLogEntry[] = [];
  return {
    id: 'test',
    received,
    write(data: Buffer) {
      for (const frame of decodeFrames(data).frames) {
        received.push((JSON.parse(frame.payload.toString()) as { params: ProcessLogEntry }).params);
      }
      return true;
    },
    end() {},
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
    },
    close() { closeHandlers.forEach((h) => { h(); }); },
  } as unknown as IpcSocket & { received: ProcessLogEntry[]; close(): void };
}

describe('LogManagerPlugin', () => {
  let dir: string;
  let events: EventBus;
  let plugin: LogManagerPlugin;
  const methods = new Map<string, Method>();
  const processConfigs = new Map<string, ProcessConfig>();

  const log = (processName: string, message: string, source: 'stdout' | 'stderr' = 'stdout', at = Date.now()) => {
    const entry: ProcessLogEntry = {
      timestamp: new Date(at).toISOString(), level: source === 'stderr' ? 'error' : 'info',
      pid: 42, processName, message, source,
    };
    events.emit('process:log', entry);
  };
  const query = async (params: Record<string, unknown> = {}) =>
    ((await methods.get('logs.query')!(params)) as ProcessLogEntry[]).map((e) => `${e.processName}:${e.message}`);

  function install(pluginConfig: Record<string, unknown> = {}): LogManagerPlugin {
    const instance = new LogManagerPlugin();
    instance.install({
      config: { daemon: { logDir: join(dir, 'logs') } },
      pluginConfig,
      events,
      logger: new Logger('log-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      registerHook: () => {},
      getPlugin: (name: string) => (name === 'process-manager'
        ? { getProcessConfig: (n: string) => processConfigs.get(n) }
        : undefined),
      registerMetric: () => {},
    } as unknown as PluginContext);
    return instance;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-logmgr-'));
    events = new EventBus();
    methods.clear();
    processConfigs.clear();
    plugin = install();
  });

  afterEach(() => {
    plugin.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should write stdout and stderr to separate JSON-lines files under daemon.logDir', () => {
    log('web', 'listening');
    log('web', 'boom', 'stderr');
    plugin.onStop();

    const out = readFileSync(join(dir, 'logs', 'web-out.log'), 'utf-8').trim().split('\n');
    const err = readFileSync(join(dir, 'logs', 'web-error.log'), 'utf-8').trim().split('\n');
    expect(out.map((l) => (JSON.parse(l) as ProcessLogEntry).message)).toEqual(['listening']);
    expect(JSON.parse(err[0]!)).toMatchObject({ level: 'error', source: 'stderr', message: 'boom', processName: 'web', pid: 42 });
  });

  it('should merge sources by time and filter by name, source, grep, since and lines', async () => {
    const t = Date.parse('2026-01-01T10:00:00Z');
    log('web', 'a', 'stdout', t);
    log('web', 'b error', 'stderr', t + 1000);
    log('api', 'c', 'stdout', t + 2000);
    log('web', 'd error', 'stdout', t + 3000);

    expect(await query()).toEqual(['web:a', 'web:b error', 'api:c', 'web:d error']);
    expect(await query({ name: 'web' })).toEqual(['web:a', 'web:b error', 'web:d error']);
    expect(await query({ source: 'stderr' })).toEqual(['web:b error']);
    expect(await query({ grep: 'err(or)?$' })).toEqual(['web:b error', 'web:d error']);
    expect(await query({ since: t + 1500 })).toEqual(['api:c', 'web:d error']);
    expect(await query({ lines: 2 })).toEqual(['api:c', 'web:d error']);
    expect(await query({ lines: 0 })).toEqual([]);
    await expect(methods.get('logs.query')!({ grep: '(' })).rejects.toThrow(/Invalid --grep pattern/);
  });

  it('should find logs written before it started, including names that need sanitizing', async () => {
    log('my app', 'first');
    plugin.onStop();
    expect(readdirSync(join(dir, 'logs'))).toContain('my_app-out.log');

    plugin = install();
    expect(await query()).toEqual(['my app:first']);
  });

  it('should stream matching entries to followers until their connection closes', async () => {
    const socket = fakeSocket();
    expect(await methods.get('logs.follow')!({ name: 'web', grep: 'keep' }, socket)).toEqual({ following: true });

    log('web', 'keep 1');
    log('api', 'keep other process');
    log('web', 'drop');
    socket.close();
    log('web', 'keep after close');

    expect(socket.received.map((e) => e.message)).toEqual(['keep 1']);
  });

  it('should flush one process or all of them', async () => {
    log('web', 'w');
    log('api', 'a');
    expect(await methods.get('logs.flush')!({ name: 'web' })).toEqual({ flushed: ['web'] });
    expect(await query()).toEqual(['api:a']);

    expect(await methods.get('logs.flush')!({})).toEqual({ flushed: ['api', 'web'] });
    expect(await query()).toEqual([]);
  });

  it('should rotate with plugin defaults, overridden per process by logRotation', () => {
    plugin.onStop();
    plugin = install({ maxSize: '300B', maxFiles: 1, compress: false });
    processConfigs.set('big', { name: 'big', script: 'x.js', logRotation: { maxSize: '100K' } });

    for (let i = 0; i < 5; i++) {
      log('small', `line ${String(i)}`);
      log('big', `line ${String(i)}`);
      plugin.query({});
    }
    plugin.onStop();

    const files = readdirSync(join(dir, 'logs')).sort();
    expect(files).toEqual(['big-out.log', 'small-out.log', 'small-out.log.1']);
    expect(existsSync(join(dir, 'logs', 'small-out.log.2'))).toBe(false);
  });
});
