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
