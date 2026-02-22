import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks
const mockExistsSync = vi.fn();
const mockResolve = vi.fn();
const mockCall = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

// Mock fs
vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

// Mock path
vi.mock('path', () => ({
  resolve: mockResolve,
}));

// Mock IpcClient
vi.mock('@opendaemon/core', () => ({
  IpcClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    call: mockCall,
  })),
}));

describe('CliClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockImplementation((...args: string[]) => args.join('/'));
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('constructor', () => {
    it('should create client with default socket path', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      
      const client = new CliClient();
      expect(client).toBeDefined();
    });

    it('should create client with custom socket path', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      
      const client = new CliClient('/custom/path.sock');
      expect(client).toBeDefined();
    });

    it('should resolve socket path', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      const { IpcClient } = await import('@opendaemon/core');
      
      new CliClient('./opendaemon.sock');
      
      expect(IpcClient).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: expect.any(String),
          timeout: 30000,
        })
      );
    });
  });

  describe('isDaemonRunning', () => {
    it('should return true when socket file exists', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      
      const client = new CliClient();
      const result = client.isDaemonRunning();
      
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.sock')
      );
      expect(result).toBe(true);
    });

    it('should return false when socket file does not exist', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      const result = client.isDaemonRunning();
      
      expect(result).toBe(false);
    });
  });

  describe('connect', () => {
    it('should connect to daemon', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockConnect.mockResolvedValue(undefined);
      
      const client = new CliClient();
      await client.connect();
      
      expect(mockConnect).toHaveBeenCalled();
    });

    it('should throw if daemon not running', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.connect()).rejects.toThrow('Daemon is not running');
    });

    it('should track connection state', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      
      const client = new CliClient();
      await client.connect();
      
      // After connect, methods requiring connection should work
      mockCall.mockResolvedValue([]);
      await client.listProcesses();
      expect(mockCall).toHaveBeenCalledWith('list');
    });
  });

  describe('disconnect', () => {
    it('should disconnect from daemon', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      
      const client = new CliClient();
      await client.connect();
      await client.disconnect();
      
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should update connection state', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      
      const client = new CliClient();
      await client.connect();
      await client.disconnect();
      
      // After disconnect, should throw on method calls
      await expect(client.listProcesses()).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('listProcesses', () => {
    it('should return process list', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue([
        { name: 'app1', status: 'online' },
        { name: 'app2', status: 'stopped' },
      ]);
      
      const client = new CliClient();
      await client.connect();
      const processes = await client.listProcesses();
      
      expect(mockCall).toHaveBeenCalledWith('list');
      expect(processes).toHaveLength(2);
      expect(processes[0]).toMatchObject({ name: 'app1', status: 'online' });
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.listProcesses()).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('startProcess', () => {
    it('should start a process', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue({ name: 'my-app', status: 'online' });
      
      const client = new CliClient();
      await client.connect();
      const result = await client.startProcess({
        name: 'my-app',
        script: './app.js',
      });
      
      expect(mockCall).toHaveBeenCalledWith('start', {
        name: 'my-app',
        script: './app.js',
      });
      expect(result).toMatchObject({ name: 'my-app', status: 'online' });
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.startProcess({})).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('stopProcess', () => {
    it('should stop a process by name', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue(undefined);
      
      const client = new CliClient();
      await client.connect();
      await client.stopProcess('my-app');
      
      expect(mockCall).toHaveBeenCalledWith('stop', { name: 'my-app', signal: undefined, timeout: undefined });
    });

    it('should stop with custom signal', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue(undefined);
      
      const client = new CliClient();
      await client.connect();
      await client.stopProcess('my-app', 'SIGTERM', 5000);
      
      expect(mockCall).toHaveBeenCalledWith('stop', {
        name: 'my-app',
        signal: 'SIGTERM',
        timeout: 5000,
      });
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.stopProcess('my-app')).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('restartProcess', () => {
    it('should restart a process', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue({ name: 'my-app', status: 'restarting' });
      
      const client = new CliClient();
      await client.connect();
      const result = await client.restartProcess('my-app');
      
      expect(mockCall).toHaveBeenCalledWith('restart', { name: 'my-app' });
      expect(result).toMatchObject({ name: 'my-app', status: 'restarting' });
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.restartProcess('my-app')).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('deleteProcess', () => {
    it('should delete a process', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue(undefined);
      
      const client = new CliClient();
      await client.connect();
      await client.deleteProcess('my-app');
      
      expect(mockCall).toHaveBeenCalledWith('delete', { name: 'my-app' });
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.deleteProcess('my-app')).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('getDaemonStatus', () => {
    it('should return daemon status', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue({
        state: 'running',
        pid: 12345,
        uptime: 3600,
      });
      
      const client = new CliClient();
      await client.connect();
      const status = await client.getDaemonStatus();
      
      expect(mockCall).toHaveBeenCalledWith('daemon.status');
      expect(status).toMatchObject({
        state: 'running',
        pid: 12345,
        uptime: 3600,
      });
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.getDaemonStatus()).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('shutdownDaemon', () => {
    it('should shutdown daemon', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue(undefined);
      
      const client = new CliClient();
      await client.connect();
      await client.shutdownDaemon();
      
      expect(mockCall).toHaveBeenCalledWith('daemon.shutdown');
    });

    it('should throw if not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      await expect(client.shutdownDaemon()).rejects.toThrow('Not connected to daemon');
    });
  });

  describe('ensureConnected', () => {
    it('should throw error when not connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(false);
      
      const client = new CliClient();
      
      // Try to call a method without connecting
      await expect(client.listProcesses()).rejects.toThrow('Not connected to daemon');
    });

    it('should not throw when connected', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockResolvedValue([]);
      
      const client = new CliClient();
      await client.connect();
      
      // Should not throw
      await expect(client.listProcesses()).resolves.toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should handle IPC call errors', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockCall.mockRejectedValue(new Error('IPC error'));
      
      const client = new CliClient();
      await client.connect();
      
      await expect(client.listProcesses()).rejects.toThrow('IPC error');
    });

    it('should handle connect errors', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      
      const client = new CliClient();
      
      await expect(client.connect()).rejects.toThrow('Connection refused');
    });

    it('should handle disconnect errors', async () => {
      const { CliClient } = await import('../../packages/cli/src/client.js');
      mockExistsSync.mockReturnValue(true);
      mockDisconnect.mockRejectedValue(new Error('Disconnect failed'));
      
      const client = new CliClient();
      await client.connect();
      
      await expect(client.disconnect()).rejects.toThrow('Disconnect failed');
    });
  });
});
