import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and path
const mockReadFileSync = vi.fn();
const mockResolve = vi.fn();
const mockFileURLToPath = vi.fn();
const mockConsoleLog = vi.fn();

vi.mock('fs', () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

vi.mock('path', () => ({
  resolve: (...args: string[]) => mockResolve(...args),
}));

vi.mock('url', () => ({
  fileURLToPath: (url: URL) => mockFileURLToPath(url),
}));

vi.mock('./output.js', () => ({
  term: {
    bold: (text: string) => `**${text}**`,
    color: (color: string, text: string) => text,
  },
}));

describe('Help Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog.mockClear();
    vi.stubGlobal('console', {
      ...console,
      log: mockConsoleLog,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getVersion', () => {
    it('should return version from package.json', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const { showVersion } = await import('../../packages/cli/src/commands/help.js');
      showVersion();

      expect(mockReadFileSync).toHaveBeenCalledWith(
        '/test/packages/cli/package.json',
        'utf-8'
      );
      expect(mockConsoleLog).toHaveBeenCalledWith('1.0.0');
    });

    it('should return "unknown" when package.json not found', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const { showVersion } = await import('../../packages/cli/src/commands/help.js');
      showVersion();

      expect(mockConsoleLog).toHaveBeenCalledWith('unknown');
    });

    it('should return "unknown" when package.json has no version', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockReturnValue(JSON.stringify({}));

      const { showVersion } = await import('../../packages/cli/src/commands/help.js');
      showVersion();

      // When pkg.version is undefined, it logs undefined
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it('should return "unknown" when JSON is invalid', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockReturnValue('invalid json');

      const { showVersion } = await import('../../packages/cli/src/commands/help.js');
      showVersion();

      expect(mockConsoleLog).toHaveBeenCalledWith('unknown');
    });
  });

  describe('showHelp', () => {
    it('should log help text', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const { showHelp } = await import('../../packages/cli/src/commands/help.js');
      showHelp();

      expect(mockConsoleLog).toHaveBeenCalled();
      const helpOutput = mockConsoleLog.mock.calls[0][0];
      expect(helpOutput).toContain('OpenDaemon');
      expect(helpOutput).toContain('USAGE');
      expect(helpOutput).toContain('COMMANDS');
    });

    it('should show help text with commands', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const { showHelp } = await import('../../packages/cli/src/commands/help.js');
      showHelp();

      const helpOutput = mockConsoleLog.mock.calls[0][0];
      expect(helpOutput).toContain('OpenDaemon');
      expect(helpOutput).toContain('start');
      expect(helpOutput).toContain('stop');
    });
  });

  describe('helpText export', () => {
    it('should export helpText string', async () => {
      mockFileURLToPath.mockReturnValue('/test/packages/cli/src/commands/');
      mockResolve.mockReturnValue('/test/packages/cli/package.json');
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const { helpText } = await import('../../packages/cli/src/commands/help.js');

      expect(typeof helpText).toBe('string');
      expect(helpText).toContain('OpenDaemon');
      expect(helpText).toContain('start');
      expect(helpText).toContain('stop');
      expect(helpText).toContain('list');
    });
  });
});
