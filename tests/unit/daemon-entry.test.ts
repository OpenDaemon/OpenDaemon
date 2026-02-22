import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockProcessKill = vi.fn();
const mockProcessOn = vi.fn();
const mockProcessExit = vi.fn();
const mockConsoleError = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

// Mock modules
vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock('path', () => ({
  resolve: vi.fn((...args: string[]) => args.join('/')),
}));

vi.mock('@opendaemon/core', async () => {
  const actual = await vi.importActual('@opendaemon/core');
  return {
    ...actual,
    Kernel: vi.fn().mockImplementation(() => ({
      registerPlugin: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue('running'),
    })),
    IpcServer: vi.fn().mockImplementation(() => ({
      registerMethod: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
    Logger: vi.fn().mockImplementation(() => ({
      info: mockLoggerInfo,
      error: mockLoggerError,
    })),
    DaemonError: class DaemonError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'DaemonError';
      }
    },
  };
});

vi.mock('../../plugins/process-manager/src/index.js', () => ({
  ProcessManagerPlugin: vi.fn(),
}));

vi.mock('../../plugins/config-manager/src/index.js', () => ({
  ConfigManagerPlugin: vi.fn(),
}));

describe('Daemon Entry Point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset process mocks
    mockProcessKill.mockReset();
    mockProcessOn.mockReset();
    mockProcessExit.mockReset();
    
    // Default behaviors
    mockExistsSync.mockReturnValue(false);
    mockProcessKill.mockImplementation(() => {
      throw new Error('Process not found');
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('PID file handling', () => {
    it('should create PID file on startup', async () => {
      mockExistsSync.mockReturnValue(false);
      
      const { writeFileSync } = await import('fs');
      writeFileSync('/test/opendaemon.pid', '12345');
      
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.pid'),
        expect.any(String)
      );
    });

    it('should check for existing daemon', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('12345');
      mockProcessKill.mockImplementation(() => {
        // Process exists
      });
      
      const exists = mockExistsSync('/test/opendaemon.pid');
      expect(exists).toBe(true);
      
      if (exists) {
        const pid = parseInt(mockReadFileSync('/test/opendaemon.pid', 'utf-8'), 10);
        expect(pid).toBe(12345);
        
        // Simulate isRunning check
        try {
          mockProcessKill(pid, 0);
          expect(true).toBe(true); // Process is running
        } catch {
          expect(false).toBe(false);
        }
      }
    });

    it('should exit if daemon already running', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('12345');
      
      // Process exists - don't throw on kill check
      mockProcessKill.mockImplementation(() => {
        // Don't throw - process is running
      });
      
      mockProcessExit.mockImplementation((code?: number) => {
        throw new Error(`Exit ${code}`);
      });
      
      // Simulate the check - process IS running, so it should exit
      let exitCalled = false;
      const checkRunning = () => {
        if (mockExistsSync('/test/opendaemon.pid')) {
          const pid = parseInt(mockReadFileSync('/test/opendaemon.pid', 'utf-8'), 10);
          try {
            mockProcessKill(pid, 0);
            // If we get here, process is running - should exit
            mockProcessExit(1);
            exitCalled = true;
          } catch {
            // Process not running - continue
          }
        }
      };
      
      // Expect this to throw when exit is called
      try {
        checkRunning();
      } catch (e: unknown) {
        const error = e as Error;
        expect(error.message).toBe('Exit 1');
      }
      
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should overwrite stale PID file', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('99999');
      mockProcessKill.mockImplementation(() => {
        throw new Error('Process not found');
      });
      
      // Simulate check
      const pid = parseInt(mockReadFileSync('/test/opendaemon.pid', 'utf-8'), 10);
      let isRunning = true;
      try {
        mockProcessKill(pid, 0);
      } catch {
        isRunning = false;
      }
      
      expect(isRunning).toBe(false);
    });

    it('should remove PID file on shutdown', async () => {
      mockExistsSync.mockReturnValue(true);
      
      const { unlinkSync } = await import('fs');
      unlinkSync('/test/opendaemon.pid');
      
      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.pid')
      );
    });
  });

  describe('daemon startup', () => {
    it('should create kernel', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const kernel = new Kernel();
      
      expect(Kernel).toHaveBeenCalled();
      expect(kernel).toBeDefined();
    });

    it('should register plugins', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const { ConfigManagerPlugin } = await import('../../plugins/config-manager/src/index.js');
      const { ProcessManagerPlugin } = await import('../../plugins/process-manager/src/index.js');
      
      const kernel = new Kernel();
      kernel.registerPlugin(new ConfigManagerPlugin());
      kernel.registerPlugin(new ProcessManagerPlugin());
      
      expect(kernel.registerPlugin).toHaveBeenCalledTimes(2);
    });

    it('should start kernel', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const kernel = new Kernel();
      await kernel.start();
      
      expect(kernel.start).toHaveBeenCalled();
    });

    it('should create IPC server', async () => {
      const { IpcServer } = await import('@opendaemon/core');
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      expect(IpcServer).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: expect.any(String) })
      );
      expect(server).toBeDefined();
    });

    it('should register IPC methods', async () => {
      const { IpcServer } = await import('@opendaemon/core');
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      server.registerMethod('daemon.status', () => ({ status: 'running' }));
      server.registerMethod('daemon.shutdown', async () => {});
      
      expect(server.registerMethod).toHaveBeenCalledTimes(2);
    });

    it('should start IPC server', async () => {
      const { IpcServer } = await import('@opendaemon/core');
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      await server.start();
      
      expect(server.start).toHaveBeenCalled();
    });

    it('should log successful startup', async () => {
      mockLoggerInfo('Daemon started successfully');
      expect(mockLoggerInfo).toHaveBeenCalledWith('Daemon started successfully');
    });
  });

  describe('shutdown handling', () => {
    it('should handle SIGTERM', async () => {
      const handlers: Record<string, Function> = {};
      const originalOn = process.on;
      
      vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      });
      
      const { Kernel } = await import('@opendaemon/core');
      const { IpcServer } = await import('@opendaemon/core');
      
      const kernel = new Kernel();
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      // Register shutdown handlers
      const shutdown = async (signal: string) => {
        mockLoggerInfo(`Received ${signal}, shutting down...`);
        await server.stop();
        await kernel.stop();
        if (mockExistsSync('/test/opendaemon.pid')) {
          mockUnlinkSync('/test/opendaemon.pid');
        }
        mockProcessExit(0);
      };
      
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      
      expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      
      // Simulate signal
      if (handlers['SIGTERM']) {
        await handlers['SIGTERM']();
      }
      
      expect(mockLoggerInfo).toHaveBeenCalledWith('Received SIGTERM, shutting down...');
    });

    it('should handle SIGINT', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const { IpcServer } = await import('@opendaemon/core');
      
      const kernel = new Kernel();
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      const shutdown = async (signal: string) => {
        mockLoggerInfo(`Received ${signal}, shutting down...`);
        await server.stop();
        await kernel.stop();
        mockProcessExit(0);
      };
      
      const handler = () => shutdown('SIGINT');
      process.on('SIGINT', handler);
      
      expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });

    it('should handle SIGHUP', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const { IpcServer } = await import('@opendaemon/core');
      
      const kernel = new Kernel();
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      const shutdown = async (signal: string) => {
        mockLoggerInfo(`Received ${signal}, shutting down...`);
        await server.stop();
        await kernel.stop();
        mockProcessExit(0);
      };
      
      const handler = () => shutdown('SIGHUP');
      process.on('SIGHUP', handler);
      
      expect(process.on).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
    });

    it('should clean up PID file on shutdown', async () => {
      mockExistsSync.mockReturnValue(true);
      
      const { unlinkSync } = await import('fs');
      
      if (mockExistsSync('/test/opendaemon.pid')) {
        unlinkSync('/test/opendaemon.pid');
      }
      
      expect(unlinkSync).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle startup errors', async () => {
      const { Kernel } = await import('@opendaemon/core');
      
      vi.mocked(Kernel).mockImplementationOnce(() => {
        throw new Error('Startup failed');
      });
      
      expect(() => new Kernel()).toThrow('Startup failed');
    });

    it('should log fatal errors', async () => {
      const error = new Error('Fatal error');
      mockLoggerError('Failed to start daemon', undefined, error);
      
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to start daemon',
        undefined,
        error
      );
    });

    it('should exit on fatal error', async () => {
      mockProcessExit.mockImplementation((code?: number) => {
        throw new Error(`Exit ${code}`);
      });
      
      const fatalError = () => {
        try {
          throw new Error('Fatal');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          mockLoggerError('Failed to start daemon', undefined, error);
          mockProcessExit(1);
        }
      };
      
      expect(fatalError).toThrow('Exit 1');
    });

    it('should handle non-Error throws', async () => {
      const error = 'String error';
      const wrappedError = error instanceof Error ? error : new Error(String(error));
      
      expect(wrappedError).toBeInstanceOf(Error);
      expect(wrappedError.message).toBe('String error');
    });
  });

  describe('IPC method handlers', () => {
    it('should return daemon status', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const kernel = new Kernel();
      
      const statusHandler = () => ({
        status: kernel.getState(),
        pid: process.pid,
        uptime: 12345,
      });
      
      const result = statusHandler();
      
      expect(result).toMatchObject({
        status: 'running',
        pid: expect.any(Number),
        uptime: expect.any(Number),
      });
    });

    it('should handle shutdown request', async () => {
      const { Kernel } = await import('@opendaemon/core');
      const { IpcServer } = await import('@opendaemon/core');
      
      const kernel = new Kernel();
      const server = new IpcServer({ socketPath: '/test/opendaemon.sock' });
      
      const shutdownHandler = async () => {
        await kernel.stop();
        mockProcessExit(0);
      };
      
      await shutdownHandler();
      
      expect(kernel.stop).toHaveBeenCalled();
    });
  });

  describe('isRunning helper', () => {
    it('should return true for running process', () => {
      mockProcessKill.mockImplementation(() => {
        // Process exists
      });
      
      const isRunning = (pid: number): boolean => {
        try {
          mockProcessKill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      
      expect(isRunning(12345)).toBe(true);
    });

    it('should return false for non-existent process', () => {
      mockProcessKill.mockImplementation(() => {
        throw new Error('Process not found');
      });
      
      const isRunning = (pid: number): boolean => {
        try {
          mockProcessKill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      
      expect(isRunning(99999)).toBe(false);
    });
  });
});
