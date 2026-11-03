import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'events';

const spawn = vi.fn();
const existsSync = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const getDaemonStatus = vi.fn();
const followLogs = vi.fn();
const listProcesses = vi.fn();
const call = vi.fn();
const startExecute = vi.fn();

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: (...args: unknown[]) => existsSync(...args),
}));
vi.mock('../../packages/cli/src/client.js', () => ({
  CliClient: class {
    connect = () => connect();
    disconnect = () => disconnect();
    getDaemonStatus = () => getDaemonStatus();
    followLogs = (...args: unknown[]) => followLogs(...args);
    listProcesses = () => listProcesses();
    call = (...args: unknown[]) => call(...args);
  },
}));
vi.mock('../../packages/cli/src/commands/index.js', () => ({
  StartCommand: class {
    options = [];
    execute = (...args: unknown[]) => startExecute(...args);
  },
  getDaemonScriptPath: () => '/opt/od/daemon.js',
}));

import { RuntimeCommand } from '../../packages/cli/src/commands/runtime.js';

/** A fake daemon process: killing it makes it exit, like a real one that handles SIGTERM */
function fakeDaemon(options: { exitOnKill?: boolean } = {}): EventEmitter & { kill: MockInstance } {
  const daemon = new EventEmitter() as EventEmitter & { kill: MockInstance };
  daemon.kill = vi.fn((signal: string) => {
    if (options.exitOnKill !== false) setImmediate(() => daemon.emit('exit', signal === 'SIGKILL' ? null : 0));
    return true;
  });
  return daemon;
}

describe('RuntimeCommand', () => {
  let exit: MockInstance;
  let stderr: MockInstance;
  let stdout: MockInstance;
  const savedHome = process.env['OPENDAEMON_HOME'];
  type Listener = (...args: unknown[]) => void;
  const EVENTS: string[] = ['exit', 'SIGTERM', 'SIGINT'];
  const listenersOf = (event: string): Listener[] => (process as unknown as EventEmitter).listeners(event) as Listener[];
  let listenersBefore: Record<string, Listener[]> = {};
  const text = (spy: MockInstance): string => spy.mock.calls.map((c) => String(c[0])).join('');

  beforeEach(() => {
    for (const fn of [spawn, existsSync, connect, disconnect, getDaemonStatus, followLogs, listProcesses, call, startExecute]) fn.mockReset();
    existsSync.mockReturnValue(true);
    connect.mockResolvedValue(undefined);
    disconnect.mockResolvedValue(undefined);
    getDaemonStatus.mockResolvedValue({});
    followLogs.mockResolvedValue(undefined);
    startExecute.mockResolvedValue(undefined);
    call.mockResolvedValue([]);
    listenersBefore = Object.fromEntries(EVENTS.map((e) => [e, listenersOf(e)]));
    process.env['OPENDAEMON_HOME'] = '/tmp/od-runtime-unit-home';
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    exit.mockRestore();
    stderr.mockRestore();
    stdout.mockRestore();
    vi.mocked(console.error).mockRestore();
    // Only the listeners this command added: the test runner has its own
    for (const event of EVENTS) {
      for (const listener of listenersOf(event)) {
        if (!listenersBefore[event]?.includes(listener)) (process as unknown as EventEmitter).removeListener(event, listener);
      }
    }
    if (savedHome === undefined) delete process.env['OPENDAEMON_HOME']; else process.env['OPENDAEMON_HOME'] = savedHome;
  });

  it('shows usage without an app', async () => {
    await new RuntimeCommand().execute([], {});
    expect(exit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails when the daemon script is missing', async () => {
    existsSync.mockReturnValue(false);
    await new RuntimeCommand().execute(['app.js'], {});
    expect(exit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('exits 1 when the daemon dies before it answers', async () => {
    const daemon = fakeDaemon();
    spawn.mockReturnValue(daemon);
    connect.mockImplementation(() => { daemon.emit('exit', 3); return Promise.reject(new Error('refused')); });
    await new RuntimeCommand().execute(['app.js'], {});
    expect(exit).toHaveBeenLastCalledWith(1);
    expect(startExecute).not.toHaveBeenCalled();
  });

  it('exits 1 and stops the daemon when the apps cannot be started', async () => {
    const daemon = fakeDaemon();
    spawn.mockReturnValue(daemon);
    startExecute.mockRejectedValue(new Error('Script not found: app.js'));
    await new RuntimeCommand().execute(['app.js'], {});
    expect(daemon.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(1);
  });

  it('starts the apps, prints their logs, and exits 0 when they have all stopped cleanly', async () => {
    const daemon = fakeDaemon();
    spawn.mockReturnValue(daemon);
    followLogs.mockImplementation((_filter: unknown, onEntry: (entry: unknown) => void) => {
      onEntry({ processName: 'web', instanceId: 2, source: 'stdout', message: 'hello' });
      onEntry({ processName: 'web', source: 'stderr', message: 'warning' });
      return Promise.resolve();
    });
    listProcesses.mockResolvedValue([{ name: 'web', status: 'stopped' }]);
    await new RuntimeCommand().execute(['app.js', '--x'], { name: 'web' });

    expect(startExecute).toHaveBeenCalledWith(['app.js', '--x'], { name: 'web' });
    expect(text(stdout)).toContain('web[2] | hello\n');
    expect(text(stderr)).toContain('web | warning\n');
    expect(daemon.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(0);
    expect(spawn.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(spawn.mock.calls[0]?.[1]).toEqual(['/opt/od/daemon.js']);
  });

  it('exits 1 when an app ended in the errored state', async () => {
    spawn.mockReturnValue(fakeDaemon());
    listProcesses.mockResolvedValue([{ name: 'a', status: 'stopped' }, { name: 'b', status: 'errored' }]);
    await new RuntimeCommand().execute(['ecosystem.config.js'], {});
    expect(exit).toHaveBeenLastCalledWith(1);
  });

  it('stays up while a scheduled job is waiting for its next run', async () => {
    const daemon = fakeDaemon();
    spawn.mockReturnValue(daemon);
    listProcesses.mockResolvedValue([{ name: 'nightly', status: 'stopped' }]);
    call.mockResolvedValue([{ name: 'nightly' }]);
    const run = new RuntimeCommand().execute(['ecosystem.config.js'], {});
    await new Promise((r) => setTimeout(r, 2300));
    expect(daemon.kill).not.toHaveBeenCalled();
    process.emit('SIGTERM');
    await run;
    expect(daemon.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('passes SIGTERM and SIGINT on to the daemon as a graceful stop, once', async () => {
    const daemon = fakeDaemon();
    spawn.mockReturnValue(daemon);
    listProcesses.mockResolvedValue([{ name: 'web', status: 'online' }]);
    const run = new RuntimeCommand().execute(['app.js'], {});
    await new Promise((r) => setTimeout(r, 300));
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await run;
    expect(daemon.kill).toHaveBeenCalledTimes(1);
    expect(daemon.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('exits 1 when the daemon crashes while the apps run', async () => {
    const daemon = fakeDaemon();
    spawn.mockReturnValue(daemon);
    listProcesses.mockResolvedValue([{ name: 'web', status: 'online' }]);
    const run = new RuntimeCommand().execute(['app.js'], {});
    await new Promise((r) => setTimeout(r, 300));
    daemon.emit('exit', 137);
    await run;
    expect(exit).toHaveBeenLastCalledWith(1);
  });
});
