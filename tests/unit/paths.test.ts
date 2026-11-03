import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { ensureHome, opendaemonHome, runtimePaths, ipcPort } from '../../packages/cli/src/paths.js';

describe('runtime paths', () => {
  const original = process.env['OPENDAEMON_HOME'];
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-home-')); });

  afterEach(() => {
    if (original === undefined) delete process.env['OPENDAEMON_HOME'];
    else process.env['OPENDAEMON_HOME'] = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it('should default to ~/.opendaemon when OPENDAEMON_HOME is unset or empty', () => {
    delete process.env['OPENDAEMON_HOME'];
    expect(opendaemonHome()).toBe(join(homedir(), '.opendaemon'));
    process.env['OPENDAEMON_HOME'] = '';
    expect(opendaemonHome()).toBe(join(homedir(), '.opendaemon'));
  });

  it('should place every runtime file under OPENDAEMON_HOME, independent of the cwd', () => {
    process.env['OPENDAEMON_HOME'] = join(dir, 'od');
    expect(runtimePaths()).toEqual({
      home: join(dir, 'od'),
      pidFile: join(dir, 'od', 'opendaemon.pid'),
      socketFile: join(dir, 'od', 'opendaemon.sock'),
      tokenFile: join(dir, 'od', 'auth-token'),
      daemonLog: join(dir, 'od', 'daemon.log'),
      logDir: join(dir, 'od', 'logs'),
    });
  });

  it.skipIf(process.platform === 'win32')('should create the home directory private to the user', () => {
    process.env['OPENDAEMON_HOME'] = join(dir, 'nested', 'od');
    const { home } = ensureHome();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // Idempotent
    expect(ensureHome().home).toBe(home);
  });
});

describe('ipcPort', () => {
  const home = process.env['OPENDAEMON_HOME'];
  const port = process.env['OPENDAEMON_IPC_PORT'];
  afterEach(() => {
    if (home === undefined) delete process.env['OPENDAEMON_HOME']; else process.env['OPENDAEMON_HOME'] = home;
    if (port === undefined) delete process.env['OPENDAEMON_IPC_PORT']; else process.env['OPENDAEMON_IPC_PORT'] = port;
  });

  it('is stable for a home, differs between homes, and stays in a range no OS hands out as ephemeral', () => {
    delete process.env['OPENDAEMON_IPC_PORT'];
    process.env['OPENDAEMON_HOME'] = '/srv/one';
    const one = ipcPort();
    expect(ipcPort()).toBe(one);
    process.env['OPENDAEMON_HOME'] = '/srv/two';
    expect(ipcPort()).not.toBe(one);
    for (const dir of ['/a', '/b/c', 'C:\\Users\\x\\.opendaemon', '/very/long/path/'.repeat(10)]) {
      process.env['OPENDAEMON_HOME'] = dir;
      expect(ipcPort()).toBeGreaterThanOrEqual(12000);
      expect(ipcPort()).toBeLessThan(25000);
    }
  });

  it('ignores the case of the home path (Windows paths are case-insensitive)', () => {
    delete process.env['OPENDAEMON_IPC_PORT'];
    process.env['OPENDAEMON_HOME'] = '/Srv/Home';
    const upper = ipcPort();
    process.env['OPENDAEMON_HOME'] = '/srv/home';
    expect(ipcPort()).toBe(upper);
  });

  it('can be set with OPENDAEMON_IPC_PORT, and ignores a bad value', () => {
    process.env['OPENDAEMON_HOME'] = '/srv/one';
    delete process.env['OPENDAEMON_IPC_PORT'];
    const derived = ipcPort();
    process.env['OPENDAEMON_IPC_PORT'] = '34567';
    expect(ipcPort()).toBe(34567);
    for (const bad of ['0', '70000', 'abc', '-3', '1.5', '']) {
      process.env['OPENDAEMON_IPC_PORT'] = bad;
      expect(ipcPort()).toBe(derived);
    }
  });
});
