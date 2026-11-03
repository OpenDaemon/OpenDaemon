import { describe, it, expect, vi, beforeEach } from 'vitest';

const call = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const followLogs = vi.fn();
const getMetrics = vi.fn();

vi.mock('../../packages/cli/src/client.js', () => ({
  CliClient: class {
    call = (...args: unknown[]) => call(...args);
    connect = () => connect();
    disconnect = () => disconnect();
    followLogs = (...args: unknown[]) => followLogs(...args);
    getMetrics = (...args: unknown[]) => getMetrics(...args);
  },
}));

import { OpenDaemon } from '../../packages/cli/src/api.js';

describe('OpenDaemon client', () => {
  let od: OpenDaemon;
  beforeEach(async () => {
    for (const fn of [call, connect, disconnect, followLogs, getMetrics]) fn.mockReset();
    connect.mockResolvedValue(undefined);
    disconnect.mockResolvedValue(undefined);
    call.mockResolvedValue('result');
    od = await OpenDaemon.connect();
  });

  it('explains how to start the daemon when it cannot be reached', async () => {
    connect.mockRejectedValue(new Error('Daemon is not running'));
    await expect(OpenDaemon.connect()).rejects.toThrow('Cannot reach the OpenDaemon daemon: Daemon is not running. Start it with "od daemon start".');
  });

  it.each([
    ['list', () => od.list(), 'list', undefined],
    ['describe', () => od.describe('a'), 'info', { name: 'a' }],
    ['start', () => od.start({ name: 'a', script: 'a.js' }), 'start', { name: 'a', script: 'a.js' }],
    ['startOrRestart', () => od.startOrRestart({ name: 'a', script: 'a.js' }), 'replace', { name: 'a', script: 'a.js' }],
    ['stop', () => od.stop('a', { signal: 'SIGINT', cascade: true }), 'stop', { name: 'a', signal: 'SIGINT', cascade: true }],
    ['stop (defaults)', () => od.stop('a'), 'stop', { name: 'a' }],
    ['restart', () => od.restart('a', { env: { X: '1' } }), 'restart', { name: 'a', env: { X: '1' } }],
    ['delete', () => od.delete('a'), 'delete', { name: 'a' }],
    ['scale', () => od.scale('a', 'max'), 'scale', { name: 'a', instances: 'max' }],
    ['save', () => od.save(), 'save', undefined],
    ['resurrect', () => od.resurrect(), 'resurrect', undefined],
    ['reset one', () => od.reset('a'), 'reset', { name: 'a' }],
    ['reset all', () => od.reset(), 'reset', {}],
    ['signal', () => od.signal('a', 'HUP'), 'signal', { name: 'a', signal: 'HUP' }],
    ['env', () => od.env('a'), 'env', { name: 'a' }],
    ['logs', () => od.logs({ name: 'a', lines: 5 }), 'logs.query', { name: 'a', lines: 5 }],
    ['logs (defaults)', () => od.logs(), 'logs.query', {}],
    ['status', () => od.status(), 'daemon.status', undefined],
  ])('%s calls the daemon method with the right parameters', async (_name, run, method, params) => {
    expect(await run()).toBe('result');
    expect(call).toHaveBeenCalledWith(method, params);
  });

  it('reads metrics in either format, and passes any other method through', async () => {
    getMetrics.mockResolvedValue('m');
    expect(await od.metrics()).toBe('m');
    expect(getMetrics).toHaveBeenLastCalledWith('json');
    await od.metrics('prometheus');
    expect(getMetrics).toHaveBeenLastCalledWith('prometheus');
    await od.call('custom.method', { a: 1 });
    expect(call).toHaveBeenLastCalledWith('custom.method', { a: 1 });
  });

  it('follows logs and disconnects', async () => {
    followLogs.mockImplementation((_q: unknown, on: (e: unknown) => void) => { on({ message: 'hi' }); return Promise.resolve(); });
    const seen: string[] = [];
    await od.follow({ name: 'a' }, (e) => { seen.push(e.message); });
    expect(seen).toEqual(['hi']);
    await od.disconnect();
    expect(disconnect).toHaveBeenCalled();
  });

  describe('reload', () => {
    const states = (...list: Array<{ state: string; steps?: string[]; error?: string } | null>) => {
      call.mockImplementation((method: string) => {
        if (method === 'deploy.execute') return Promise.resolve({ started: true });
        return Promise.resolve(list.length > 1 ? list.shift() : list[0]);
      });
    };

    it('starts a rolling deploy and waits for it to finish', async () => {
      states({ state: 'running', steps: [] }, { state: 'succeeded', steps: ['done'] });
      expect(await od.reload('a', { env: { X: '1' } })).toEqual({ state: 'succeeded', steps: ['done'] });
      expect(call).toHaveBeenCalledWith('deploy.execute', { name: 'a', strategy: 'rolling', release: { env: { X: '1' } } });
    });

    it('rejects when it was rolled back, and when there is no deploy to follow', async () => {
      states({ state: 'rolled-back', error: 'the new worker never became ready' });
      await expect(od.reload('a')).rejects.toThrow('Reload of a rolled-back: the new worker never became ready');
      states({ state: 'failed' });
      await expect(od.reload('a')).rejects.toThrow('Reload of a failed: unknown error');
      states(null);
      await expect(od.reload('a')).rejects.toThrow('No deploy of "a"');
    });
  });
});
