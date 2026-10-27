import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { ensureHome, opendaemonHome, runtimePaths } from '../../packages/cli/src/paths.js';

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
