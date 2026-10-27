#!/usr/bin/env node

import { Kernel, Logger } from '@opendaemon/core';
import { IpcServer } from '@opendaemon/core';
import { ProcessManagerPlugin } from '../../plugins/process-manager/src/index.js';
import { ConfigManagerPlugin } from '../../plugins/config-manager/src/index.js';
import { WebuiPlugin } from '../../plugins/webui/src/index.js';
import { HealthCheckPlugin } from '../../plugins/health-check/src/index.js';
import { LogManagerPlugin } from '../../plugins/log-manager/src/index.js';

import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import { ensureHome, runtimePaths } from './paths.js';

/**
 * Remove the PID file (only if it is ours) and the IPC token file
 */
function removeRuntimeFiles(): void {
  const { pidFile, tokenFile } = runtimePaths();
  if (existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim() === String(process.pid)) {
    unlinkSync(pidFile);
  }
  if (existsSync(tokenFile)) {
    unlinkSync(tokenFile);
  }
}

/**
 * Check if process is running
 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon entry point
 */
export async function main(): Promise<void> {
  const logger = new Logger('daemon');
  
  try {
    // Runtime files live in $OPENDAEMON_HOME (default ~/.opendaemon), not the current directory
    const { pidFile, socketFile: socketPath, tokenFile, logDir } = ensureHome();

    // Check if daemon is already running
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
      if (isRunning(pid)) {
        logger.error('Daemon is already running');
        process.exit(1);
      }
    }

    // Write PID file
    writeFileSync(pidFile, String(process.pid));

    // Load configuration through the config manager (TS/JS/JSON/YAML/package.json),
    // so the file it finds is what every plugin receives as context.config.
    // An invalid config is fatal: silently starting without the user's apps is worse.
    const configManager = new ConfigManagerPlugin();
    const config = await configManager.load();
    // Process logs default to the home directory, like the other runtime files
    config.daemon = { ...config.daemon, logDir: config.daemon?.logDir ?? logDir };

    // Create kernel
    const kernel = new Kernel();

    // Create IPC server FIRST (before registering plugins)
    // Use TCP on Windows (Unix sockets have permission issues), Unix socket on Linux/Mac
    const isWindows = process.platform === 'win32';

    // Every IPC request must carry this token. Only the daemon's user can read the token file,
    // so other local users cannot drive the daemon (and run code as this user) even when they
    // can reach the TCP port (Windows) or the socket (a permissive umask or shared group)
    const authToken = randomBytes(32).toString('hex');
    if (existsSync(tokenFile)) {
      unlinkSync(tokenFile); // the mode below only applies when the file is created
    }
    writeFileSync(tokenFile, authToken, { mode: 0o600 });

    const ipcConfig = isWindows
      ? { host: '127.0.0.1', port: 9995, authToken }
      : { socketPath, authToken };
    const ipcServer = new IpcServer(ipcConfig);

    // Connect kernel to IPC server so plugins can register methods
    kernel.setIpcServer(ipcServer);

    // Register plugins (they will register their RPC methods now)
    kernel.registerPlugin(configManager);
    kernel.registerPlugin(new LogManagerPlugin());
    kernel.registerPlugin(new ProcessManagerPlugin());
    kernel.registerPlugin(new HealthCheckPlugin());
    kernel.registerPlugin(new WebuiPlugin());

    // Start kernel with configuration
    await kernel.start(config);

    // Register IPC methods
    ipcServer.registerMethod('daemon.status', () => ({
      status: kernel.getState(),
      pid: process.pid,
      uptime: process.uptime(),
    }));

    // Start IPC server
    await ipcServer.start();
    if (!isWindows) {
      chmodSync(socketPath, 0o600);
    }

    logger.info('Daemon started successfully');

    // Handle shutdown
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      // Repeated signals (e.g. Ctrl+C twice) must not run a second teardown
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}, shutting down...`);

      let exitCode = 0;
      try {
        await ipcServer.stop();
        await kernel.stop();
      } catch (err) {
        logger.error('Error during shutdown', undefined, err as Error);
        exitCode = 1;
      } finally {
        // Clean up even when teardown failed, so the next start is not blocked
        removeRuntimeFiles();
      }

      process.exit(exitCode);
    };

    // Reply first, then run the same teardown as a signal would (PID/token cleanup included)
    ipcServer.registerMethod('daemon.shutdown', () => {
      setImmediate(() => { void shutdown('daemon.shutdown'); });
      return { ok: true };
    });

    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

    // Keep process alive
    process.stdin.resume();

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Failed to start daemon', undefined, error);
    // Remove our PID and token files so a failed start does not block the next one
    removeRuntimeFiles();
    process.exit(1);
  }
}

// Only run main if this file is executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('daemon.ts') || process.argv[1]?.endsWith('daemon.js')) {
  main().catch((err: unknown) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
