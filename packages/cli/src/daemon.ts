#!/usr/bin/env node

import { Kernel, Logger } from '@opendaemon/core';
import { IpcServer } from '@opendaemon/core';
import { ProcessManagerPlugin } from '../../plugins/process-manager/src/index.js';
import { ConfigManagerPlugin } from '../../plugins/config-manager/src/index.js';
import { WebuiPlugin } from '../../plugins/webui/src/index.js';
import { HealthCheckPlugin } from '../../plugins/health-check/src/index.js';

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

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
    // Check if daemon is already running
    const pidFile = resolve('opendaemon.pid');
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

    // Create kernel
    const kernel = new Kernel();

    // Create IPC server FIRST (before registering plugins)
    // Use TCP on Windows (Unix sockets have permission issues), Unix socket on Linux/Mac
    const isWindows = process.platform === 'win32';
    const ipcConfig = isWindows
      ? { host: '127.0.0.1', port: 9995 }
      : { socketPath: resolve('opendaemon.sock') };
    const ipcServer = new IpcServer(ipcConfig);

    // Connect kernel to IPC server so plugins can register methods
    kernel.setIpcServer(ipcServer);

    // Register plugins (they will register their RPC methods now)
    kernel.registerPlugin(configManager);
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

    ipcServer.registerMethod('daemon.shutdown', async () => {
      await kernel.stop();
      process.exit(0);
    });

    // Start IPC server
    await ipcServer.start();

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
        // Clean up PID file even when teardown failed, so the next start is not blocked
        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
        }
      }

      process.exit(exitCode);
    };

    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

    // Keep process alive
    process.stdin.resume();

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Failed to start daemon', undefined, error);
    // Remove our PID file so a failed start does not block the next one
    const pidFile = resolve('opendaemon.pid');
    if (existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim() === String(process.pid)) {
      unlinkSync(pidFile);
    }
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
