import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const call = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const getProcessInfo = vi.fn();
const getDaemonStatus = vi.fn();
const ensureDaemonRunning = vi.fn().mockResolvedValue(undefined);
const deployExecute = vi.fn().mockResolvedValue(undefined);
const restartExecute = vi.fn().mockResolvedValue(undefined);

vi.mock('../../packages/cli/src/client.js', () => ({
  CliClient: class {
    call = (...args: unknown[]) => call(...args);
    connect = () => connect();
    disconnect = () => disconnect();
    getProcessInfo = (...args: unknown[]) => getProcessInfo(...args);
    getDaemonStatus = () => getDaemonStatus();
  },
}));

vi.mock('../../packages/cli/src/commands/index.js', () => ({
  ensureDaemonRunning: () => ensureDaemonRunning(),
  DeployCommand: class { execute = (...args: unknown[]) => deployExecute(...args); },
  RestartCommand: class { execute = (...args: unknown[]) => restartExecute(...args); },
}));

import {
  SaveCommand, ResurrectCommand, ResetCommand, SignalCommand, ReloadCommand, PingCommand, EcosystemCommand,
} from '../../packages/cli/src/commands/lifecycle.js';

describe('lifecycle commands', () => {
  let log: MockInstance;
  let error: MockInstance;
  let exit: MockInstance;
  const printed = (spy: MockInstance): string => spy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    call.mockReset();
    connect.mockReset().mockResolvedValue(undefined);
    disconnect.mockReset().mockResolvedValue(undefined);
    getProcessInfo.mockReset();
    getDaemonStatus.mockReset().mockResolvedValue({});
    ensureDaemonRunning.mockClear();
    deployExecute.mockClear();
    restartExecute.mockClear();
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => { log.mockRestore(); error.mockRestore(); exit.mockRestore(); });

  describe('save', () => {
    it('reports how many processes were saved and where', async () => {
      call.mockResolvedValue({ file: '/home/u/.opendaemon/dump.json', saved: ['a', 'b'] });
      await new SaveCommand().execute([], {});
      expect(call).toHaveBeenCalledWith('save');
      expect(printed(log)).toContain('Saved 2 process(es) to /home/u/.opendaemon/dump.json');
      expect(disconnect).toHaveBeenCalled();
    });

    it('prints JSON with --json', async () => {
      call.mockResolvedValue({ file: 'f', saved: ['a'] });
      await new SaveCommand().execute([], { json: true });
      expect(JSON.parse(printed(log))).toEqual({ file: 'f', saved: ['a'] });
    });

    it('exits 1 with the reason when the daemon refuses, and still disconnects', async () => {
      call.mockRejectedValue(new Error('no home'));
      await new SaveCommand().execute([], {});
      expect(printed(error)).toContain('Failed to save: no home');
      expect(exit).toHaveBeenCalledWith(1);
      expect(disconnect).toHaveBeenCalled();
    });

    it('does not start a daemon just to save', async () => {
      connect.mockRejectedValue(new Error('Daemon is not running'));
      await new SaveCommand().execute([], {});
      expect(ensureDaemonRunning).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('resurrect', () => {
    it('starts the daemon if needed and reports the result', async () => {
      call.mockResolvedValue({ started: ['a'], skipped: ['b', 'c'], failed: [] });
      await new ResurrectCommand().execute([], {});
      expect(ensureDaemonRunning).toHaveBeenCalled();
      expect(call).toHaveBeenCalledWith('resurrect');
      expect(printed(log)).toContain('Started 1, left as they were 2');
      expect(exit).not.toHaveBeenCalled();
    });

    it('exits 1 and names what could not be started', async () => {
      call.mockResolvedValue({ started: [], skipped: [], failed: ['broken'] });
      await new ResurrectCommand().execute([], {});
      expect(printed(error)).toContain('Could not start: broken');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('prints JSON with --json', async () => {
      const result = { started: ['a'], skipped: [], failed: [] };
      call.mockResolvedValue(result);
      await new ResurrectCommand().execute([], { json: true });
      expect(JSON.parse(printed(log))).toEqual(result);
    });
  });

  describe('reset', () => {
    it('resets one process, or all with "all" or no name', async () => {
      call.mockResolvedValue(['web']);
      await new ResetCommand().execute(['web'], {});
      expect(call).toHaveBeenLastCalledWith('reset', { name: 'web' });
      await new ResetCommand().execute(['all'], {});
      expect(call).toHaveBeenLastCalledWith('reset', {});
      await new ResetCommand().execute([], {});
      expect(call).toHaveBeenLastCalledWith('reset', {});
      expect(printed(log)).toContain('Reset the restart counter of 1 process(es)');
    });

    it('prints JSON with --json', async () => {
      call.mockResolvedValue(['a', 'b']);
      await new ResetCommand().execute([], { json: true });
      expect(JSON.parse(printed(log))).toEqual(['a', 'b']);
    });
  });

  describe('signal', () => {
    it('takes the name first or the signal first (PM2 order)', async () => {
      call.mockResolvedValue([123]);
      await new SignalCommand().execute(['api', 'SIGUSR2'], {});
      expect(call).toHaveBeenLastCalledWith('signal', { name: 'api', signal: 'SIGUSR2' });
      await new SignalCommand().execute(['SIGUSR2', 'api'], {});
      expect(call).toHaveBeenLastCalledWith('signal', { name: 'api', signal: 'SIGUSR2' });
      await new SignalCommand().execute(['HUP', 'api'], {});
      expect(call).toHaveBeenLastCalledWith('signal', { name: 'api', signal: 'HUP' });
    });

    it('keeps a lower-case process name as the name', async () => {
      call.mockResolvedValue([1]);
      await new SignalCommand().execute(['web', 'usr2'], {});
      expect(call).toHaveBeenLastCalledWith('signal', { name: 'web', signal: 'usr2' });
      expect(printed(log)).toContain('Sent SIGUSR2 to web (1)');
    });

    it('prints JSON with --json', async () => {
      call.mockResolvedValue([5, 6]);
      await new SignalCommand().execute(['api', 'TERM'], { json: true });
      expect(JSON.parse(printed(log))).toEqual({ name: 'api', signal: 'TERM', pids: [5, 6] });
    });

    it('shows usage and exits 1 without both arguments', async () => {
      await new SignalCommand().execute(['api'], {});
      expect(printed(error)).toContain('Usage: od signal <name> <signal>');
      expect(exit).toHaveBeenCalledWith(1);
      expect(call).not.toHaveBeenCalled();
    });

    it('reports a daemon error', async () => {
      call.mockRejectedValue(new Error('Unknown signal "NOPE"'));
      await new SignalCommand().execute(['api', 'NOPE'], {});
      expect(printed(error)).toContain('Failed to send the signal: Unknown signal "NOPE"');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('reload', () => {
    it('does a rolling deploy for a cluster app', async () => {
      getProcessInfo.mockResolvedValue({ mode: 'cluster' });
      await new ReloadCommand().execute(['api'], { json: true });
      expect(deployExecute).toHaveBeenCalledWith(['api'], expect.objectContaining({ strategy: 'rolling', json: true }));
      expect(restartExecute).not.toHaveBeenCalled();
    });

    it('restarts a fork app', async () => {
      getProcessInfo.mockResolvedValue({ mode: 'fork' });
      await new ReloadCommand().execute(['web'], { cascade: true });
      expect(restartExecute).toHaveBeenCalledWith(['web'], { cascade: true });
      expect(deployExecute).not.toHaveBeenCalled();
    });

    it('restarts when the daemon does not know the app (the restart reports it)', async () => {
      getProcessInfo.mockResolvedValue(null);
      await new ReloadCommand().execute(['ghost'], {});
      expect(restartExecute).toHaveBeenCalled();
    });

    it('needs a name, and reports a daemon that is not running', async () => {
      await new ReloadCommand().execute([], {});
      expect(printed(error)).toContain('No process name specified');
      connect.mockRejectedValue(new Error('Daemon is not running'));
      await new ReloadCommand().execute(['api'], {});
      expect(printed(error)).toContain('Failed to reload process: Daemon is not running');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('ping', () => {
    it('answers pong, or says the daemon is not running', async () => {
      await new PingCommand().execute();
      expect(printed(log)).toContain('pong');
      getDaemonStatus.mockRejectedValue(new Error('x'));
      await new PingCommand().execute();
      expect(printed(error)).toContain('The daemon is not running');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('ecosystem', () => {
    let dir: string;
    let cwd: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-eco-cmd-')); cwd = process.cwd(); process.chdir(dir); });
    afterEach(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });

    it('writes a sample file once and refuses to overwrite it', async () => {
      await new EcosystemCommand().execute();
      const file = join(dir, 'ecosystem.config.cjs');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('env_production');
      expect(exit).not.toHaveBeenCalled();

      writeFileSync(file, 'mine');
      await new EcosystemCommand().execute();
      expect(printed(error)).toContain('already exists');
      expect(exit).toHaveBeenCalledWith(1);
      expect(readFileSync(file, 'utf-8')).toBe('mine');
    });
  });
});
