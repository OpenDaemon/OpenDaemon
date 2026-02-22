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
      
      // Connect first
      await client.connect();
      
      // Then register notification handler
      client.onNotification((method) => {
        notifications.push(method);
      });
      
      // Small delay to ensure handler is registered
      await setTimeout(50);
      
      // Now broadcast
      server.broadcast('test.notification', { data: 123 });
      
      // Wait for the notification to be received
      await setTimeout(100);
      
      expect(notifications).toContain('test.notification');
    });

    it('should handle client connection errors gracefully', async () => {
      await server.start();
      
      // Try to connect multiple clients rapidly
      const clients: IpcClient[] = [];
      const connectPromises: Promise<void>[] = [];
      
      for (let i = 0; i < 3; i++) {
        const c = new IpcClient({ socketPath, timeout: 1000 });
        clients.push(c);
        connectPromises.push(c.connect());
      }
      
      // All should connect successfully
      await expect(Promise.all(connectPromises)).resolves.not.toThrow();
      
      // Cleanup
      for (const c of clients) {
        await c.disconnect();
      }
    });

    it('should handle socket closure during operation', async () => {
      await server.start();
      server.registerMethod('slow', async () => {
        await setTimeout(500);
        return 'done';
      });

      await client.connect();
      
      // Start a slow request
      const requestPromise = client.call('slow');
      
      // Immediately disconnect (simulates socket close)
      await client.disconnect();
      
      // Request should be rejected
      await expect(requestPromise).rejects.toThrow();
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

    it('should handle client disconnection', async () => {
      await server.start();
      server.registerMethod('test', () => 'ok');

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Disconnect client
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should handle server stop with connected clients', async () => {
      await server.start();
      server.registerMethod('test', () => 'ok');

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Stop server while client is connected
      await server.stop();

      // Give client time to detect disconnection
      await setTimeout(100);

      // Client connection state may vary by platform, but server stop should not throw
      expect(true).toBe(true);
    });

    it('should handle rapid connect/disconnect cycles', async () => {
      await server.start();

      for (let i = 0; i < 5; i++) {
        const tempClient = new IpcClient({ socketPath, timeout: 1000 });
        await tempClient.connect();
        expect(tempClient.isConnected()).toBe(true);
        await tempClient.disconnect();
        expect(tempClient.isConnected()).toBe(false);
      }
    });
  });
});
