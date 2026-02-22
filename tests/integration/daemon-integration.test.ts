import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockKernelStart = vi.fn().mockResolvedValue(undefined);
const mockKernelStop = vi.fn().mockResolvedValue(undefined);
const mockKernelGetState = vi.fn().mockReturnValue('running');
const mockKernelRegisterPlugin = vi.fn();
const mockIpcServerStart = vi.fn().mockResolvedValue(undefined);
const mockIpcServerStop = vi.fn().mockResolvedValue(undefined);
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockProcessOn = vi.fn();

// Track registered methods
const registeredMethods: Record<string, Function> = {};

// Mock modules
vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

vi.mock('path', () => ({
  resolve: vi.fn((...args: string[]) => args.join('/')),
}));

vi.mock('@opendaemon/core', () => ({
  Kernel: vi.fn().mockImplementation(() => ({
    registerPlugin: (...args: any[]) => mockKernelRegisterPlugin(...args),
    start: () => mockKernelStart(),
    stop: () => mockKernelStop(),
    getState: () => mockKernelGetState(),
  })),
  IpcServer: vi.fn().mockImplementation(() => ({
    registerMethod: (name: string, handler: Function) => {
      registeredMethods[name] = handler;
    },
    start: () => mockIpcServerStart(),
    stop: () => mockIpcServerStop(),
  })),
  Logger: vi.fn().mockImplementation(() => ({
    info: (...args: any[]) => mockLoggerInfo(...args),
    error: (...args: any[]) => mockLoggerError(...args),
  })),
  DaemonError: class DaemonError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DaemonError';
    }
  },
}));

vi.mock('../../plugins/process-manager/src/index.js', () => ({
  ProcessManagerPlugin: vi.fn(),
}));

vi.mock('../../plugins/config-manager/src/index.js', () => ({
  ConfigManagerPlugin: vi.fn(),
}));

describe('Daemon Entry Point Integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(registeredMethods).forEach(key => delete registeredMethods[key]);
    
    // Reset modules
    vi.resetModules();
    
    // Mock process.exit to prevent test runner termination
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    
    // Default success state
    mockExistsSync.mockReturnValue(false);
  });
  
  afterEach(() => {
    exitSpy.mockRestore();
  });

  describe('startup flow', () => {
    it('should check for existing PID file', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.pid')
      );
    });

    it('should write PID file', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.pid'),
        expect.any(String)
      );
    });

    it('should create kernel', async () => {
      const { Kernel } = await import('@opendaemon/core');
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(Kernel).toHaveBeenCalled();
    });

    it('should register plugins', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Both ConfigManagerPlugin and ProcessManagerPlugin should be registered
      expect(mockKernelRegisterPlugin).toHaveBeenCalledTimes(2);
    });

    it('should start kernel', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockKernelStart).toHaveBeenCalled();
    });

    it('should create IPC server', async () => {
      const { IpcServer } = await import('@opendaemon/core');
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(IpcServer).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: expect.stringContaining('opendaemon.sock'),
        })
      );
    });

    it('should register IPC methods', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(registeredMethods['daemon.status']).toBeDefined();
      expect(registeredMethods['daemon.shutdown']).toBeDefined();
    });

    it('should start IPC server', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockIpcServerStart).toHaveBeenCalled();
    });

    it('should log successful startup', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockLoggerInfo).toHaveBeenCalledWith('Daemon started successfully');
    });
  });

  describe('IPC method functionality', () => {
    it('should return status from daemon.status', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const statusHandler = registeredMethods['daemon.status'];
      expect(statusHandler).toBeDefined();
      
      const result = statusHandler?.();
      
      expect(result).toMatchObject({
        status: 'running',
        pid: expect.any(Number),
        uptime: expect.any(Number),
      });
    });

    it('should call kernel.stop on daemon.shutdown', async () => {
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const shutdownHandler = registeredMethods['daemon.shutdown'];
      expect(shutdownHandler).toBeDefined();
      
      try {
        await shutdownHandler?.();
      } catch {
        // Expected - process.exit is called
      }
      
      expect(mockKernelStop).toHaveBeenCalled();
    });
  });

  describe('signal handling registration', () => {
    it('should register SIGTERM handler', async () => {
      const spy = vi.spyOn(process, 'on');
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(spy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      spy.mockRestore();
    });

    it('should register SIGINT handler', async () => {
      const spy = vi.spyOn(process, 'on');
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(spy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      spy.mockRestore();
    });

    it('should register SIGHUP handler', async () => {
      const spy = vi.spyOn(process, 'on');
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(spy).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
      spy.mockRestore();
    });

    it('should execute shutdown handler when signal received', async () => {
      const handlers: Record<string, Function> = {};
      vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      });
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Trigger SIGTERM handler
      if (handlers['SIGTERM']) {
        try {
          await handlers['SIGTERM']();
        } catch {
          // process.exit throws
        }
      }
      
      // Verify shutdown was called
      expect(mockLoggerInfo).toHaveBeenCalledWith('Received SIGTERM, shutting down...');
      expect(mockIpcServerStop).toHaveBeenCalled();
      expect(mockKernelStop).toHaveBeenCalled();
    });

    it('should clean up PID file on shutdown', async () => {
      const handlers: Record<string, Function> = {};
      vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      });
      
      // PID file exists during shutdown
      mockExistsSync.mockReturnValue(true);
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Trigger SIGTERM handler
      if (handlers['SIGTERM']) {
        try {
          await handlers['SIGTERM']();
        } catch {
          // process.exit throws
        }
      }
      
      // Verify PID file was checked and unlinked
      expect(mockExistsSync).toHaveBeenCalled();
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('opendaemon.pid'));
    });

    it('should handle shutdown when PID file does not exist', async () => {
      const handlers: Record<string, Function> = {};
      vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      });
      
      // PID file does not exist
      mockExistsSync.mockReturnValue(false);
      
      await import('../../packages/cli/src/daemon.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Trigger SIGTERM handler
      if (handlers['SIGTERM']) {
        try {
          await handlers['SIGTERM']();
        } catch {
          // process.exit throws
        }
      }
      
      // Verify PID file was checked but unlink was not called
      expect(mockExistsSync).toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('already running check', () => {
    it('should check PID file exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('12345');
      
      // Mock process.kill to throw (process doesn't exist)
      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => { throw new Error('No such process'); }) as any;
      
      try {
        await import('../../packages/cli/src/daemon.js');
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch {
        // Expected
      }
      
      process.kill = originalKill;
      
      expect(mockReadFileSync).toHaveBeenCalled();
    });

    it('should log error when daemon already running', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('12345');
      
      // Mock process.kill to succeed (process exists)
      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {}) as any;
      
      try {
        await import('../../packages/cli/src/daemon.js');
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch {
        // Expected - process.exit is called
      }
      
      process.kill = originalKill;
      
      expect(mockLoggerError).toHaveBeenCalledWith('Daemon is already running');
    });
  });

  describe('error handling', () => {
    it('should handle kernel start errors', async () => {
      mockKernelStart.mockRejectedValue(new Error('Kernel failed'));
      
      try {
        await import('../../packages/cli/src/daemon.js');
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch {
        // Expected - process.exit is called
      }
      
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to start daemon',
        undefined,
        expect.any(Error)
      );
    });

    it('should handle IPC server errors', async () => {
      mockIpcServerStart.mockRejectedValue(new Error('IPC failed'));
      
      try {
        await import('../../packages/cli/src/daemon.js');
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch {
        // Expected - process.exit is called
      }
      
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });
});
