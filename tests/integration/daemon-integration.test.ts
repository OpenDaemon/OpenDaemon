import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Declare mock variables at module level
let mockLoggerInfo: ReturnType<typeof vi.fn>;
let mockLoggerError: ReturnType<typeof vi.fn>;
let mockKernelStart: ReturnType<typeof vi.fn>;
let mockKernelStop: ReturnType<typeof vi.fn>;
let mockKernelGetState: ReturnType<typeof vi.fn>;
let mockKernelRegisterPlugin: ReturnType<typeof vi.fn>;
let mockKernelSetIpcServer: ReturnType<typeof vi.fn>;
let mockIpcServerStart: ReturnType<typeof vi.fn>;
let mockIpcServerStop: ReturnType<typeof vi.fn>;
let mockIpcServerRegisterMethod: ReturnType<typeof vi.fn>;
let mockExistsSync: ReturnType<typeof vi.fn>;
let mockReadFileSync: ReturnType<typeof vi.fn>;
let mockWriteFileSync: ReturnType<typeof vi.fn>;
let mockUnlinkSync: ReturnType<typeof vi.fn>;

// Track registered methods
const registeredMethods: Record<string, Function> = {};

// Mock modules - use factory functions that reference the module-level variables
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
    setIpcServer: (...args: any[]) => mockKernelSetIpcServer(...args),
    start: () => mockKernelStart(),
    stop: () => mockKernelStop(),
    getState: () => mockKernelGetState(),
  })),
  IpcServer: vi.fn().mockImplementation(() => ({
    registerMethod: (name: string, handler: Function) => {
      registeredMethods[name] = handler;
      mockIpcServerRegisterMethod(name, handler);
    },
    start: () => mockIpcServerStart(),
    stop: () => mockIpcServerStop(),
  })),
  Logger: vi.fn().mockImplementation(() => ({
    info: (...args: any[]) => mockLoggerInfo(...args),
    error: (...args: any[]) => mockLoggerError(...args),
  })),
}));

vi.mock('../../plugins/process-manager/src/index.js', () => ({
  ProcessManagerPlugin: vi.fn(),
}));

vi.mock('../../plugins/config-manager/src/index.js', () => ({
  ConfigManagerPlugin: vi.fn(),
}));

vi.mock('../../plugins/webui/src/index.js', () => ({
  WebuiPlugin: vi.fn(),
}));

// Import the daemon functions after mocks
import { main, isRunning } from '../../packages/cli/src/daemon.js';

describe('Daemon Entry Point Integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalPlatform = process.platform;
  
  beforeEach(() => {
    // Initialize all mocks
    mockLoggerInfo = vi.fn();
    mockLoggerError = vi.fn();
    mockKernelStart = vi.fn().mockResolvedValue(undefined);
    mockKernelStop = vi.fn().mockResolvedValue(undefined);
    mockKernelGetState = vi.fn().mockReturnValue('running');
    mockKernelRegisterPlugin = vi.fn();
    mockKernelSetIpcServer = vi.fn();
    mockIpcServerStart = vi.fn().mockResolvedValue(undefined);
    mockIpcServerStop = vi.fn().mockResolvedValue(undefined);
    mockIpcServerRegisterMethod = vi.fn();
    mockExistsSync = vi.fn().mockReturnValue(false);
    mockReadFileSync = vi.fn();
    mockWriteFileSync = vi.fn();
    mockUnlinkSync = vi.fn();

    // Clear registered methods
    Object.keys(registeredMethods).forEach(key => delete registeredMethods[key]);
    
    // Mock process.exit to prevent test runner termination
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    
    // Reset platform
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });
  
  afterEach(() => {
    exitSpy.mockRestore();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  describe('isRunning helper', () => {
    it('should return true when process exists', () => {
      const originalKill = process.kill;
      process.kill = vi.fn().mockReturnValue(true) as any;
      
      const result = isRunning(12345);
      
      expect(result).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(12345, 0);
      
      process.kill = originalKill;
    });

    it('should return false when process does not exist', () => {
      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw new Error('No such process');
      }) as any;
      
      const result = isRunning(99999);
      
      expect(result).toBe(false);
      
      process.kill = originalKill;
    });
  });

  describe('startup flow', () => {
    it('should check for existing PID file', async () => {
      await main();
      
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.pid')
      );
    });

    it('should write PID file', async () => {
      await main();
      
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('opendaemon.pid'),
        expect.any(String)
      );
    });

    it('should create kernel', async () => {
      const { Kernel } = await import('@opendaemon/core');
      
      await main();
      
      expect(Kernel).toHaveBeenCalled();
    });

    it('should register plugins', async () => {
      await main();
      
      // Both ConfigManagerPlugin and ProcessManagerPlugin should be registered
      expect(mockKernelRegisterPlugin).toHaveBeenCalledTimes(3);
    });

    it('should start kernel', async () => {
      await main();
      
      expect(mockKernelStart).toHaveBeenCalled();
    });

    it('should create IPC server with TCP on Windows', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      const { IpcServer } = await import('@opendaemon/core');
      
      await main();
      
      expect(IpcServer).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '127.0.0.1',
          port: 9995,
        })
      );
    });

    it('should create IPC server with Unix socket on Linux', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const { IpcServer } = await import('@opendaemon/core');
      
      await main();
      
      expect(IpcServer).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: expect.stringContaining('opendaemon.sock'),
        })
      );
    });

    it('should register IPC methods', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      await main();
      
      expect(registeredMethods['daemon.status']).toBeDefined();
      expect(registeredMethods['daemon.shutdown']).toBeDefined();
    });

    it('should start IPC server', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      await main();
      
      expect(mockIpcServerStart).toHaveBeenCalled();
    });

    it('should log successful startup', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      await main();
      
      expect(mockLoggerInfo).toHaveBeenCalledWith('Daemon started successfully');
    });
  });

  describe('IPC method functionality', () => {
    it('should return status from daemon.status', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      await main();
      
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
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      await main();
      
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
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const handlers: Record<string, Function> = {};
      const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      }) as any);
      
      await main();
      
      expect(handlers['SIGTERM']).toBeDefined();
      spy.mockRestore();
    });

    it('should register SIGINT handler', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const handlers: Record<string, Function> = {};
      const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      }) as any);
      
      await main();
      
      expect(handlers['SIGINT']).toBeDefined();
      spy.mockRestore();
    });

    it('should register SIGHUP handler', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const handlers: Record<string, Function> = {};
      const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      }) as any);
      
      await main();
      
      expect(handlers['SIGHUP']).toBeDefined();
      spy.mockRestore();
    });

    it('should execute shutdown handler when signal received', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const handlers: Record<string, Function> = {};
      vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      }) as any);
      
      await main();
      
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
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const handlers: Record<string, Function> = {};
      vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      }) as any);
      
      // PID file exists during shutdown
      mockExistsSync.mockReturnValue(true);
      
      await main();
      
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
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      const handlers: Record<string, Function> = {};
      vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return process;
      });
      
      // PID file does not exist
      mockExistsSync.mockReturnValue(false);
      
      await main();
      
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
      
      await main();
      
      process.kill = originalKill;
      
      expect(mockReadFileSync).toHaveBeenCalled();
    });

    it('should log error when daemon already running', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('12345');
      
      // Mock process.kill to succeed (process exists)
      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {}) as any;
      
      await main();
      
      process.kill = originalKill;
      
      expect(mockLoggerError).toHaveBeenCalledWith('Daemon is already running');
    });
  });

  describe('error handling', () => {
    it('should handle kernel start errors', async () => {
      mockKernelStart.mockRejectedValue(new Error('Kernel failed'));
      
      await main();
      
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to start daemon',
        undefined,
        expect.any(Error)
      );
    });

    it('should handle IPC server errors', async () => {
      mockIpcServerStart.mockRejectedValue(new Error('IPC failed'));
      
      await main();
      
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });
});
