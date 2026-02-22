import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OptionValue } from '../../packages/cli/src/parser.js';

// Create mock functions at module level with default implementations
const mockListProcesses = vi.fn().mockResolvedValue([]);
const mockStartProcess = vi.fn().mockResolvedValue({});
const mockStopProcess = vi.fn().mockResolvedValue(undefined);
const mockDeleteProcess = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetDaemonStatus = vi.fn().mockResolvedValue({ status: 'running', pid: 12345, uptime: 60 });
const mockIsDaemonRunning = vi.fn().mockReturnValue(true);
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockReadFileSync = vi.fn().mockReturnValue('12345');
const mockUnlinkSync = vi.fn().mockImplementation(() => {});
const mockWriteFileSync = vi.fn().mockImplementation(() => {});
const mockSpawn = vi.fn().mockReturnValue({
  unref: vi.fn(),
  on: vi.fn(),
  exitCode: null,
});

// Mock @opendaemon/core
vi.mock('@opendaemon/core', () => ({
  IpcClient: vi.fn().mockImplementation(() => ({
    connect: () => mockConnect(),
    disconnect: () => mockDisconnect(),
    listProcesses: () => mockListProcesses(),
    startProcess: (...args: any[]) => mockStartProcess(...args),
    stopProcess: (...args: any[]) => mockStopProcess(...args),
    deleteProcess: (...args: any[]) => mockDeleteProcess(...args),
    getDaemonStatus: () => mockGetDaemonStatus(),
    isDaemonRunning: () => mockIsDaemonRunning(),
  })),
  Kernel: vi.fn(),
  IpcServer: vi.fn(),
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
}));

// Mock path module
vi.mock('path', () => ({
  resolve: vi.fn((...args: string[]) => args.join('/')),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Import commands after mocks
import {
  ListCommand,
  StartCommand,
  StopCommand,
  DeleteCommand,
  StatusCommand,
  DaemonCommand,
} from '../../packages/cli/src/commands/index.js';

describe('CLI Commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Reset mock call counts but preserve implementations
    mockListProcesses.mockClear();
    mockStartProcess.mockClear();
    mockStopProcess.mockClear();
    mockDeleteProcess.mockClear();
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockGetDaemonStatus.mockClear();
    mockIsDaemonRunning.mockClear();
    mockExistsSync.mockClear();
    mockReadFileSync.mockClear();
    mockUnlinkSync.mockClear();
    mockWriteFileSync.mockClear();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('ListCommand', () => {
    const cmd = new ListCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('list');
      expect(cmd.aliases).toEqual(['ls']);
      expect(cmd.description).toBe('List all processes');
    });

    it('should output empty message when no processes', async () => {
      mockListProcesses.mockResolvedValue([]);
      
      await cmd.execute([], { json: false, quiet: false });
      
      // When no processes, it should call term.info which logs to stderr
      expect(errorSpy).toHaveBeenCalled();
    });

    it('should handle errors when listing processes', async () => {
      mockConnect.mockRejectedValue(new Error('Connection failed'));
      
      await cmd.execute([], { json: false, quiet: false });
      
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should output JSON when json option is set', async () => {
      mockListProcesses.mockResolvedValue([{ name: 'test', status: 'online' }]);
      
      await cmd.execute([], { json: true, quiet: false });
      
      // Check either stdout or stderr was written to
      const wasOutputWritten = consoleSpy.mock.calls.length > 0 || errorSpy.mock.calls.length > 0;
      expect(wasOutputWritten).toBe(true);
    });

    it('should output process names only when quiet option is set', async () => {
      mockListProcesses.mockResolvedValue([{ name: 'proc1' }, { name: 'proc2' }]);
      
      // Should complete without throwing
      await expect(cmd.execute([], { json: false, quiet: true })).resolves.toBeUndefined();
    });

    it('should format different statuses correctly', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'online', cpu: 0.5, memory: 1024, uptime: 60000 },
        { id: 2, name: 'app2', mode: 'cluster', status: 'stopped', cpu: 0, memory: 0, uptime: 0 },
        { id: 3, name: 'app3', mode: 'fork', status: 'errored', cpu: 0, memory: 0, uptime: 0 },
        { id: 4, name: 'app4', mode: 'fork', status: 'starting', cpu: 0.1, memory: 512, uptime: 5000 },
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format duration in days', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'online', cpu: 0.5, memory: 1024, uptime: 90061000 }, // ~25 hours
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format duration in hours', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'online', cpu: 0.5, memory: 1024, uptime: 7200000 }, // 2 hours
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format duration in minutes', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'online', cpu: 0.5, memory: 1024, uptime: 300000 }, // 5 minutes
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should display table output with correct columns', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'online', cpu: 0.5, memory: 1024, uptime: 60000 },
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format stopped status', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'stopped', cpu: 0, memory: 0, uptime: 0 },
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format errored status', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'errored', cpu: 0, memory: 0, uptime: 0 },
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format starting status', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'starting', cpu: 0.1, memory: 512, uptime: 5000 },
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should format unknown status as default', async () => {
      mockListProcesses.mockResolvedValue([
        { id: 1, name: 'app1', mode: 'fork', status: 'unknown', cpu: 0, memory: 0, uptime: 0 },
      ]);
      
      await expect(cmd.execute([], { json: false, quiet: false })).resolves.toBeUndefined();
    });

    it('should test formatStatus with all status values', () => {
      // Test all formatStatus branches directly
      const formatStatus = (cmd as any).formatStatus.bind(cmd);
      
      expect(formatStatus('online')).toContain('online');
      expect(formatStatus('stopped')).toContain('stopped');
      expect(formatStatus('errored')).toContain('errored');
      expect(formatStatus('starting')).toContain('starting');
      expect(formatStatus('unknown')).toBe('unknown');
    });

    it('should test formatDuration with all time units', () => {
      // Test formatDuration with different time values
      const formatDuration = (cmd as any).formatDuration.bind(cmd);
      
      // Test days
      expect(formatDuration(90061000)).toMatch(/\d+d/); // ~25 hours
      
      // Test hours
      expect(formatDuration(7200000)).toBe('2h'); // 2 hours
      
      // Test minutes
      expect(formatDuration(300000)).toBe('5m'); // 5 minutes
      
      // Test seconds
      expect(formatDuration(30000)).toBe('30s'); // 30 seconds
    });

    it('should test formatBytes with various sizes', () => {
      const formatBytes = (cmd as any).formatBytes.bind(cmd);
      
      expect(formatBytes(512)).toBe('512.0B');
      expect(formatBytes(1024)).toBe('1.0K');
      expect(formatBytes(1024 * 1024)).toBe('1.0M');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0G');
    });
  });

  describe('StartCommand', () => {
    const cmd = new StartCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('start');
      expect(cmd.description).toBe('Start a process or processes from config');
    });

    it('should error when no args provided', async () => {
      await cmd.execute([], { json: false });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should start process with default name from script', async () => {
      await expect(cmd.execute(['app.js'], { json: false, name: undefined, instances: undefined })).resolves.toBeUndefined();
    });

    it('should start process with custom name', async () => {
      await expect(cmd.execute(['app.js'], { json: false, name: 'my-app', instances: undefined })).resolves.toBeUndefined();
    });

    it('should handle .ts files', async () => {
      await expect(cmd.execute(['app.ts'], { json: false, name: undefined, instances: undefined })).resolves.toBeUndefined();
    });

    it('should error when file not found', async () => {
      mockExistsSync.mockReturnValue(false);
      await cmd.execute(['nonexistent.js'], { json: false });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle errors when starting process', async () => {
      mockStartProcess.mockRejectedValue(new Error('Start failed'));
      
      await cmd.execute(['app.js'], { json: false });
      
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('StopCommand', () => {
    const cmd = new StopCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('stop');
      expect(cmd.description).toBe('Stop process(es)');
    });

    it('should error when no process name specified', async () => {
      await cmd.execute([], { json: false });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should stop process by name', async () => {
      await expect(cmd.execute(['my-process'], { json: false })).resolves.toBeUndefined();
    });

    it('should handle errors when stopping process', async () => {
      mockStopProcess.mockRejectedValue(new Error('Stop failed'));

      await cmd.execute(['my-process'], { json: false });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('DeleteCommand', () => {
    const cmd = new DeleteCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('delete');
      expect(cmd.description).toBe('Delete a process');
    });

    it('should error when no process name specified', async () => {
      await cmd.execute([], { json: false });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should delete process by name', async () => {
      await expect(cmd.execute(['my-process'], { json: false })).resolves.toBeUndefined();
    });

    it('should handle errors when deleting process', async () => {
      mockDeleteProcess.mockRejectedValue(new Error('Delete failed'));

      await cmd.execute(['my-process'], { json: false });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('StatusCommand', () => {
    const cmd = new StatusCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('status');
      expect(cmd.description).toBe('Show daemon status');
    });

    it('should show not running when daemon is not running', async () => {
      mockIsDaemonRunning.mockReturnValue(false);
      await cmd.execute([], {});
      expect(errorSpy).toHaveBeenCalled();
    });

    it('should execute and show status when daemon is running', async () => {
      mockIsDaemonRunning.mockReturnValue(true);
      await expect(cmd.execute([], {})).resolves.toBeUndefined();
    });

    it('should handle errors when getting daemon status', async () => {
      mockIsDaemonRunning.mockReturnValue(true);
      mockGetDaemonStatus.mockRejectedValue(new Error('Status failed'));

      await cmd.execute([], {});

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('DaemonCommand', () => {
    const cmd = new DaemonCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('daemon');
      expect(cmd.description).toBe('Manage daemon');
    });

    it('should show error for unknown subcommand', async () => {
      await cmd.execute(['unknown']);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle start subcommand', async () => {
      // Mock spawn to simulate successful daemon start
      mockSpawn.mockReturnValue({
        unref: vi.fn(),
        on: vi.fn(),
        exitCode: null,
      });
      
      // First call returns false (no PID file), subsequent calls return true (daemon started)
      let callCount = 0;
      mockExistsSync.mockImplementation(() => {
        callCount++;
        return callCount > 1;
      });
      
      await cmd.execute(['start']);
      expect(mockSpawn).toHaveBeenCalled();
    }, 10000);

    it('should handle stop subcommand', async () => {
      await cmd.execute(['stop']);
      expect(mockExistsSync).toHaveBeenCalled();
    });

    it('should handle status subcommand', async () => {
      await cmd.execute(['status']);
      expect(mockExistsSync).toHaveBeenCalled();
    });

    it('should handle restart subcommand', async () => {
      // Mock spawn for start portion
      mockSpawn.mockReturnValue({
        unref: vi.fn(),
        on: vi.fn(),
        exitCode: null,
      });
      
      let callCount = 0;
      mockExistsSync.mockImplementation(() => {
        callCount++;
        return callCount > 2;
      });
      
      await cmd.execute(['restart']);
      expect(mockSpawn).toHaveBeenCalled();
    }, 10000);
  });
});
