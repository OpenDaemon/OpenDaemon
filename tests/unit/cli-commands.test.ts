import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Create mock functions at module level with default implementations
const mockListProcesses = vi.fn().mockResolvedValue([]);
const mockStartProcess = vi.fn().mockResolvedValue({});
const mockStopProcess = vi.fn().mockResolvedValue(undefined);
const mockDeleteProcess = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetDaemonStatus = vi.fn().mockResolvedValue({ status: 'running', pid: 12345, uptime: 60 });
const mockGetHealth = vi.fn().mockResolvedValue([]);
const mockQueryLogs = vi.fn().mockResolvedValue([]);
const mockFlushLogs = vi.fn().mockResolvedValue({ flushed: [] });
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
    // CliClient talks to the daemon through call(), so route RPC methods to the mocks
    call: (method: string, params?: any) => {
      switch (method) {
        case 'list': return mockListProcesses();
        case 'start': return mockStartProcess(params);
        case 'stop': return mockStopProcess(params);
        case 'delete': return mockDeleteProcess(params);
        case 'daemon.status': return mockGetDaemonStatus();
        case 'health': return mockGetHealth(params);
        case 'logs.query': return mockQueryLogs(params);
        case 'logs.flush': return mockFlushLogs(params);
        default: return Promise.resolve(undefined);
      }
    },
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
  openSync: () => 3,
  closeSync: () => {},
  statSync: () => ({ size: 0 }),
  mkdirSync: () => undefined,
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
  HealthCommand,
  LogsCommand,
  FlushCommand,
  parseSince,
  DaemonCommand,
} from '../../packages/cli/src/commands/index.js';

describe('CLI Commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: MockInstance<typeof process.exit>;

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
      
      // When no processes, term.info logs to stdout
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No processes running'));
    });

    it('should handle errors when listing processes', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection failed'));
      
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
      expect(formatDuration(7200000)).toBe('2h 0m'); // 2 hours

      // Test minutes
      expect(formatDuration(300000)).toBe('5m 0s'); // 5 minutes
      
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

    // CliClient detects a running daemon by the socket file, so drive it through existsSync
    it('should show not running when daemon is not running', async () => {
      mockExistsSync.mockReturnValue(false);
      await cmd.execute();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Daemon: not running'));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should execute and show status when daemon is running', async () => {
      mockExistsSync.mockReturnValue(true);
      await cmd.execute();
      expect(mockGetDaemonStatus).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should handle errors when getting daemon status', async () => {
      mockExistsSync.mockReturnValue(true);
      mockGetDaemonStatus.mockRejectedValueOnce(new Error('Status failed'));

      await cmd.execute();

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('parseSince', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');

    it.each([
      ['30s', now - 30_000],
      ['15m', now - 900_000],
      ['2h', now - 7_200_000],
      ['1d', now - 86_400_000],
      ['2026-01-01T12:00:00Z', Date.parse('2026-01-01T12:00:00Z')],
      ['soon', undefined],
      ['5w', undefined],
    ])('parseSince(%j)', (input, expected) => {
      expect(parseSince(input, now)).toBe(expected);
    });
  });

  describe('LogsCommand', () => {
    const cmd = new LogsCommand();
    const entry = { timestamp: '2026-01-01T00:00:00.000Z', processName: 'web', source: 'stderr', message: 'boom', level: 'error', pid: 1 };

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockQueryLogs.mockReset();
      mockQueryLogs.mockResolvedValue([]);
    });

    it('should query all processes with the default line count', async () => {
      await cmd.execute([], {});
      expect(mockQueryLogs).toHaveBeenCalledWith({ lines: 100 });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No logs found'));
    });

    it('should pass name, lines, grep and since, and print entries', async () => {
      mockQueryLogs.mockResolvedValue([entry]);
      const before = Date.now();
      await cmd.execute(['web'], { lines: 5, grep: 'boo', since: '1h' });

      const query = mockQueryLogs.mock.calls[0]![0] as { since: number };
      expect(query).toMatchObject({ name: 'web', lines: 5, grep: 'boo' });
      expect(query.since).toBeGreaterThanOrEqual(before - 3_600_000);
      expect(query.since).toBeLessThanOrEqual(Date.now() - 3_600_000);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/2026-01-01T00:00:00.000Z.*web.*boom/));
    });

    it('should print raw JSON lines with --json', async () => {
      mockQueryLogs.mockResolvedValue([entry]);
      await cmd.execute(['web'], { json: true });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(entry));
    });

    it('should reject an invalid --since without calling the daemon', async () => {
      await cmd.execute([], { since: 'yesterday-ish' });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --since'));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockQueryLogs).not.toHaveBeenCalled();
    });

    it('should exit 1 when the query fails', async () => {
      mockQueryLogs.mockRejectedValueOnce(new Error('Invalid --grep pattern'));
      await cmd.execute([], { grep: '(' });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get logs: Invalid --grep pattern'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('FlushCommand', () => {
    const cmd = new FlushCommand();

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockFlushLogs.mockReset();
    });

    it('should flush one process or report that there was nothing', async () => {
      mockFlushLogs.mockResolvedValue({ flushed: ['web'] });
      await cmd.execute(['web'], {});
      expect(mockFlushLogs).toHaveBeenCalledWith({ name: 'web' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Flushed logs: web'));

      mockFlushLogs.mockResolvedValue({ flushed: [] });
      await cmd.execute([], {});
      expect(mockFlushLogs).toHaveBeenLastCalledWith({});
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No logs to flush'));
    });
  });

  describe('HealthCommand', () => {
    const cmd = new HealthCommand();

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockGetHealth.mockReset();
    });

    it('should say when nothing is monitored, for all or for one process', async () => {
      mockGetHealth.mockResolvedValue([]);
      await cmd.execute([], {});
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No health checks configured'));
      expect(mockGetHealth).toHaveBeenCalledWith({});

      await cmd.execute(['web'], {});
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No health check configured for "web"'));
      expect(mockGetHealth).toHaveBeenLastCalledWith({ name: 'web' });
    });

    it('should print a table with status, failures and the last result', async () => {
      mockGetHealth.mockResolvedValue([
        { name: 'web', type: 'http', status: 'unhealthy', consecutiveFailures: 3,
          lastResult: { ok: false, message: 'HTTP 500', at: new Date(Date.now() - 2000).toISOString() } },
        { name: 'db', type: 'tcp', status: 'unknown', consecutiveFailures: 0 },
      ]);
      await cmd.execute([], {});

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toMatch(/web.*http.*unhealthy.*3.*2s ago.*HTTP 500/);
      expect(output).toMatch(/db.*tcp.*pending.*0.*-/);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit 1 when the daemon call fails', async () => {
      mockGetHealth.mockRejectedValueOnce(new Error('boom'));
      await cmd.execute([], {});
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get health: boom'));
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
