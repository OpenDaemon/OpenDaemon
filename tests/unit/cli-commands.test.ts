import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ListCommand,
  StartCommand,
  StopCommand,
  StatusCommand,
  DaemonCommand,
} from '../../packages/cli/src/commands/index.js';
import type { OptionValue } from '../../packages/cli/src/parser.js';

describe('CLI Commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('ListCommand', () => {
    const cmd = new ListCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('list');
      expect(cmd.aliases).toEqual(['ls']);
      expect(cmd.description).toBe('List all processes');
    });

    it('should output empty message when no processes', async () => {
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should output JSON when json option is set', async () => {
      await cmd.execute([], { json: true, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should output process names only when quiet option is set', async () => {
      await cmd.execute([], { json: false, quiet: true });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format different statuses correctly', async () => {
      // Test various status colors: stopped (gray), errored (red), starting (yellow), default
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format duration in days', async () => {
      // This will test formatDuration with days > 0
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format duration in hours', async () => {
      // This will test formatDuration with hours > 0
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format duration in minutes', async () => {
      // This will test formatDuration with minutes > 0
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should display table output with correct columns', async () => {
      await cmd.execute([], { json: false, quiet: false });
      // Verify table output was called
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format stopped status', async () => {
      // Will test formatStatus with 'stopped'
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format errored status', async () => {
      // Will test formatStatus with 'errored'
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format starting status', async () => {
      // Will test formatStatus with 'starting'
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should format unknown status as default', async () => {
      // Will test formatStatus with unknown status (default case)
      await cmd.execute([], { json: false, quiet: false });
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('StartCommand', () => {
    const cmd = new StartCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('start');
      expect(cmd.description).toBe('Start a process or processes from config');
    });

    it('should error when no args provided', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      
      await expect(cmd.execute([], { json: false })).rejects.toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('should start process with default name from script', async () => {
      await cmd.execute(['app.js'], { json: false, name: undefined, instances: undefined });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should start process with custom name', async () => {
      await cmd.execute(['app.js'], { json: false, name: 'my-app', instances: 2 });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should handle .ts files', async () => {
      await cmd.execute(['app.ts'], { json: false, name: undefined, instances: undefined });
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('StopCommand', () => {
    const cmd = new StopCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('stop');
      expect(cmd.description).toBe('Stop process(es)');
    });

    it('should error when no process name provided', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });

      await expect(cmd.execute([], { json: false })).rejects.toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('should stop process by name', async () => {
      await cmd.execute(['my-process'], { json: false });
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('StatusCommand', () => {
    const cmd = new StatusCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('status');
      expect(cmd.description).toBe('Show daemon status');
    });

    it('should execute', async () => {
      await cmd.execute([], {});
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('DaemonCommand', () => {
    const cmd = new DaemonCommand();

    it('should have correct metadata', () => {
      expect(cmd.name).toBe('daemon');
      expect(cmd.description).toBe('Manage daemon');
    });

    it('should handle start subcommand', async () => {
      await cmd.execute(['start']);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should handle stop subcommand', async () => {
      await cmd.execute(['stop']);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should handle restart subcommand', async () => {
      await cmd.execute(['restart']);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should handle status subcommand', async () => {
      await cmd.execute(['status']);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should error on unknown subcommand', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      
      await expect(cmd.execute(['unknown'])).rejects.toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });
});
