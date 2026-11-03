import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { createHash } from 'crypto';

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

/**
 * The TCP port of the daemon's IPC where there are no Unix sockets (Windows). Derived from the
 * home directory, so each user, and each OPENDAEMON_HOME, gets its own daemon instead of all of
 * them fighting over one fixed port. `OPENDAEMON_IPC_PORT` overrides it.
 */
export function ipcPort(): number {
  const fromEnv = Number(process.env['OPENDAEMON_IPC_PORT']);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  const hash = createHash('sha256').update(opendaemonHome().toLowerCase()).digest().readUInt16BE(0);
  return 12000 + (hash % 13000);
}
