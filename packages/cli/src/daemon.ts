#!/usr/bin/env node

import { Kernel, Logger } from '@opendaemon/core';
import { IpcServer } from '@opendaemon/core';
import { ProcessManagerPlugin } from '../../plugins/process-manager/src/index.js';
import { ConfigManagerPlugin } from '../../plugins/config-manager/src/index.js';

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

/**
 * Daemon entry point
 */
async function main(): Promise<void> {
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

    // Create kernel
    const kernel = new Kernel();

    // Create IPC server FIRST (before registering plugins)
    // Use TCP on Windows (Unix sockets have permission issues), Unix socket on Linux/Mac
    const isWindows = process.platform === 'win32';
    const ipcConfig = isWindows
      ? { host: '127.0.0.1', port: 9876 }
      : { socketPath: resolve('opendaemon.sock') };
    const ipcServer = new IpcServer(ipcConfig);

    // Connect kernel to IPC server so plugins can register methods
    kernel.setIpcServer(ipcServer);

    // Register plugins (they will register their RPC methods now)
    kernel.registerPlugin(new ConfigManagerPlugin());
    kernel.registerPlugin(new ProcessManagerPlugin());

    // Start kernel
    await kernel.start();

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
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      await ipcServer.stop();
      await kernel.stop();
      
      // Clean up PID file
      if (existsSync(pidFile)) {
        unlinkSync(pidFile);
      }
      
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));

    // Keep process alive
    process.stdin.resume();

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Failed to start daemon', undefined, error);
    process.exit(1);
  }
}

/**
 * Check if process is running
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
