import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks
const mockShowHelp = vi.fn();
const mockShowVersion = vi.fn();
const mockListExecute = vi.fn().mockResolvedValue(undefined);
const mockStartExecute = vi.fn().mockResolvedValue(undefined);
const mockStopExecute = vi.fn().mockResolvedValue(undefined);
const mockStatusExecute = vi.fn().mockResolvedValue(undefined);
const mockDaemonExecute = vi.fn().mockResolvedValue(undefined);
const mockTermError = vi.fn();

// Mock all dependencies
vi.mock('../../packages/cli/src/commands/help.js', () => ({
  showHelp: (...args: any[]) => mockShowHelp(...args),
  showVersion: (...args: any[]) => mockShowVersion(...args),
}));

vi.mock('../../packages/cli/src/commands/index.js', () => ({
  ListCommand: vi.fn().mockImplementation(() => ({
    execute: (...args: any[]) => mockListExecute(...args),
  })),
  StartCommand: vi.fn().mockImplementation(() => ({
    execute: (...args: any[]) => mockStartExecute(...args),
  })),
  StopCommand: vi.fn().mockImplementation(() => ({
    execute: (...args: any[]) => mockStopExecute(...args),
  })),
  StatusCommand: vi.fn().mockImplementation(() => ({
    execute: (...args: any[]) => mockStatusExecute(...args),
  })),
  DaemonCommand: vi.fn().mockImplementation(() => ({
    execute: (...args: any[]) => mockDaemonExecute(...args),
  })),
}));

vi.mock('../../packages/cli/src/output.js', () => ({
  term: {
    error: (...args: any[]) => mockTermError(...args),
    info: vi.fn(),
    color: vi.fn((c: string, t: string) => t),
    bold: vi.fn((t: string) => t),
    table: vi.fn(() => 'table'),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
  },
}));

describe('CLI Entry Point Integration', () => {
  let originalArgv: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    
    // Reset modules to ensure fresh imports
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('help flag handling', () => {
    it('should call showHelp when --help is passed', async () => {
      process.argv = ['node', 'cli', '--help'];
      
      await import('../../packages/cli/src/cli.js');
      
      // Wait for async main
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockShowHelp).toHaveBeenCalled();
    });

    it('should call showHelp when -h is passed', async () => {
      process.argv = ['node', 'cli', '-h'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockShowHelp).toHaveBeenCalled();
    });
  });

  describe('version flag handling', () => {
    it('should call showVersion when --version is passed', async () => {
      process.argv = ['node', 'cli', '--version'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockShowVersion).toHaveBeenCalled();
    });
  });

  describe('command routing', () => {
    it('should route to list command', async () => {
      process.argv = ['node', 'cli', 'list'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockListExecute).toHaveBeenCalled();
    });

    it('should route to ls alias', async () => {
      process.argv = ['node', 'cli', 'ls'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockListExecute).toHaveBeenCalled();
    });

    it('should route to start command', async () => {
      process.argv = ['node', 'cli', 'start', 'app.js'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockStartExecute).toHaveBeenCalled();
    });

    it('should route to stop command', async () => {
      process.argv = ['node', 'cli', 'stop', 'my-app'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockStopExecute).toHaveBeenCalled();
    });

    it('should route to status command', async () => {
      process.argv = ['node', 'cli', 'status'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockStatusExecute).toHaveBeenCalled();
    });

    it('should route to daemon command', async () => {
      process.argv = ['node', 'cli', 'daemon', 'start'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockDaemonExecute).toHaveBeenCalled();
    });

    it('should show help for empty command', async () => {
      process.argv = ['node', 'cli'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockShowHelp).toHaveBeenCalled();
    });
  });

  describe('option passing', () => {
    it('should pass options to commands', async () => {
      process.argv = ['node', 'cli', '--json', '--quiet', 'list'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockListExecute).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          json: true,
          quiet: true,
        })
      );
    });

    it('should pass config option', async () => {
      process.argv = ['node', 'cli', '-c', './config.js', 'list'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockListExecute).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ config: './config.js' })
      );
    });
  });

  describe('error handling', () => {
    it('should handle command execution errors', async () => {
      mockListExecute.mockRejectedValue(new Error('Command failed'));
      process.argv = ['node', 'cli', 'list'];
      
      // Import should not throw, errors are caught
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockTermError).toHaveBeenCalledWith('Command failed');
    });

    it('should handle string errors', async () => {
      mockListExecute.mockRejectedValue('String error');
      process.argv = ['node', 'cli', 'list'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockTermError).toHaveBeenCalledWith('String error');
    });

    it('should show stack trace with --verbose on error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at Test.method';
      mockListExecute.mockRejectedValue(error);
      
      process.argv = ['node', 'cli', '--verbose', 'list'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(consoleSpy).toHaveBeenCalledWith(error.stack);
      consoleSpy.mockRestore();
    });

    it('should handle unknown commands', async () => {
      process.argv = ['node', 'cli', 'unknown-command'];
      
      await import('../../packages/cli/src/cli.js');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockTermError).toHaveBeenCalledWith('Unknown command: unknown-command');
    });
  });
});
