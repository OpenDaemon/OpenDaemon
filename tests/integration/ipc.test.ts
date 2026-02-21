import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IpcServer } from '../../packages/core/src/ipc/server.js';
import { IpcClient } from '../../packages/core/src/ipc/client.js';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { setTimeout } from 'timers/promises';

describe('IPC', () => {
  // Use named pipe on Windows, socket file on Unix
  const socketPath = process.platform === 'win32' 
    ? '\\\\.\\pipe\\test-ipc-opendaemon' 
    : resolve('./test-ipc.sock');
  let server: IpcServer;
  let client: IpcClient;

  beforeEach(async () => {
    // Clean up any existing socket (Unix only)
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    server = new IpcServer({ socketPath });
    client = new IpcClient({ socketPath, timeout: 5000 });
  });

  afterEach(async () => {
    try {
      await client.disconnect();
    } catch {
      // Ignore
    }
    
    try {
      await server.stop();
    } catch {
      // Ignore
    }

    // Clean up socket (Unix only)
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  });

  describe('Server', () => {
    it('should start and stop', async () => {
      await server.start();
      // On Unix, socket file should exist. On Windows named pipe, we can't check file existence.
      if (process.platform !== 'win32') {
        expect(existsSync(socketPath)).toBe(true);
      }
      
      await server.stop();
    });

    it('should register and call methods', async () => {
      await server.start();

      server.registerMethod('echo', (params) => params);
      
      await client.connect();
      const result = await client.call('echo', { message: 'hello' });
      
      expect(result).toEqual({ message: 'hello' });
    });

    it('should return error for unknown methods', async () => {
      await server.start();
      await client.connect();
      
      await expect(client.call('unknown')).rejects.toThrow('Method not found');
    });

    it('should handle multiple clients', async () => {
      await server.start();
      server.registerMethod('test', () => 'ok');

      const client2 = new IpcClient({ socketPath, timeout: 5000 });
      
      await client.connect();
      await client2.connect();

      const [result1, result2] = await Promise.all([
        client.call('test'),
        client2.call('test'),
      ]);

      expect(result1).toBe('ok');
      expect(result2).toBe('ok');

      await client2.disconnect();
    });

    it('should broadcast to all clients', async () => {
      await server.start();

      const notifications: string[] = [];
      client.onNotification((method) => {
        notifications.push(method);
      });

      await client.connect();
      
      server.broadcast('test.notification', { data: 123 });
      
      // Wait a bit longer for the notification to be received
      await setTimeout(500);
      
      expect(notifications).toContain('test.notification');
    });
  });

  describe('Client', () => {
    it('should connect and disconnect', async () => {
      await server.start();
      
      expect(client.isConnected()).toBe(false);
      
      await client.connect();
      expect(client.isConnected()).toBe(true);
      
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should reject when not connected', async () => {
      await expect(client.call('test')).rejects.toThrow('Not connected');
    });

    it('should reject on connection refused', async () => {
      // Don't start server
      await expect(client.connect()).rejects.toThrow();
    });

    it('should timeout on slow responses', async () => {
      await server.start();
      
      server.registerMethod('slow', async () => {
        await setTimeout(10000);
        return 'done';
      });

      const fastClient = new IpcClient({ socketPath, timeout: 100 });
      await fastClient.connect();

      await expect(fastClient.call('slow')).rejects.toThrow('timeout');
      
      await fastClient.disconnect();
    });
  });
});
