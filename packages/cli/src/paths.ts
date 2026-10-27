import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Where the daemon keeps its runtime files: $OPENDAEMON_HOME, or ~/.opendaemon.
 *
 * A fixed location (rather than the current directory) lets `od` find the daemon from
 * any directory, and keeps the Unix socket path short enough for the 108-byte limit.
 */
export function opendaemonHome(): string {
  const fromEnv = process.env['OPENDAEMON_HOME'];
  return resolve(fromEnv !== undefined && fromEnv !== '' ? fromEnv : resolve(homedir(), '.opendaemon'));
}

export interface RuntimePaths {
  home: string;
  pidFile: string;
  socketFile: string;
  /** IPC auth token, readable only by the daemon's user */
  tokenFile: string;
  /** The daemon's own stdout/stderr */
  daemonLog: string;
  /** Default directory for process logs */
  logDir: string;
}

export function runtimePaths(): RuntimePaths {
  const home = opendaemonHome();
  return {
    home,
    pidFile: resolve(home, 'opendaemon.pid'),
    socketFile: resolve(home, 'opendaemon.sock'),
    tokenFile: resolve(home, 'auth-token'),
    daemonLog: resolve(home, 'daemon.log'),
    logDir: resolve(home, 'logs'),
  };
}

/**
 * Create the home directory, private to this user
 */
export function ensureHome(): RuntimePaths {
  const paths = runtimePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  return paths;
}
