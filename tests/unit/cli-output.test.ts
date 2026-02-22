import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalOutput, term } from '../../packages/cli/src/output.js';
import { EventEmitter } from 'events';

describe('TerminalOutput', () => {
  let output: TerminalOutput;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    output = new TerminalOutput();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('color', () => {
    it('should return colored text when TTY', () => {
      const result = output.color('red', 'test');
      if (process.stdout.isTTY && !process.env.NO_COLOR) {
        expect(result).toContain('\x1b[');
        expect(result).toContain('test');
      } else {
        expect(result).toBe('test');
      }
    });

    it('should return plain text when NO_COLOR is set', () => {
      const originalNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = '1';
      const result = output.color('red', 'test');
      expect(result).toBe('test');
      process.env.NO_COLOR = originalNoColor;
    });
  });

  describe('bold', () => {
    it('should return bold text', () => {
      const result = output.bold('test');
      if (process.stdout.isTTY && !process.env.NO_COLOR) {
        expect(result).toContain('\x1b[');
        expect(result).toContain('test');
      } else {
        expect(result).toBe('test');
      }
    });
  });

  describe('dim', () => {
    it('should return dim text', () => {
      const result = output.dim('test');
      if (process.stdout.isTTY && !process.env.NO_COLOR) {
        expect(result).toContain('\x1b[');
        expect(result).toContain('test');
      } else {
        expect(result).toBe('test');
      }
    });
  });

  describe('table', () => {
    it('should create table with headers and rows', () => {
      const headers = ['Name', 'Status'];
      const rows = [['app1', 'online'], ['app2', 'stopped']];
      const result = output.table(headers, rows);
      
      expect(result).toContain('Name');
      expect(result).toContain('Status');
      expect(result).toContain('app1');
      expect(result).toContain('online');
      expect(result).toContain('app2');
      expect(result).toContain('stopped');
    });

    it('should handle empty rows', () => {
      const headers = ['Name', 'Status'];
      const rows: string[][] = [];
      const result = output.table(headers, rows);
      expect(result).toBe('');
    });

    it('should handle single row', () => {
      const headers = ['Name'];
      const rows = [['test']];
      const result = output.table(headers, rows);
      expect(result).toContain('test');
    });
  });

  describe('list', () => {
    it('should create bullet list', () => {
      const items = ['item1', 'item2', 'item3'];
      const result = output.list(items);
      
      expect(result).toContain('• item1');
      expect(result).toContain('• item2');
      expect(result).toContain('• item3');
    });

    it('should handle empty list', () => {
      const result = output.list([]);
      expect(result).toBe('');
    });

    it('should handle single item', () => {
      const result = output.list(['item']);
      expect(result).toBe('  • item');
    });
  });

  describe('keyValue', () => {
    it('should format key-value pair', () => {
      const result = output.keyValue('Name', 'Value');
      expect(result).toContain('Name:');
      expect(result).toContain('Value');
    });
  });

  describe('success', () => {
    it('should print success message', () => {
      output.success('Operation completed');
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Operation completed');
    });
  });

  describe('error', () => {
    it('should print error message to stderr', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      output.error('Something went wrong');
      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls[0][0]).toContain('Something went wrong');
      errorSpy.mockRestore();
    });
  });

  describe('warn', () => {
    it('should print warning message', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      output.warn('Warning message');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toContain('Warning message');
      warnSpy.mockRestore();
    });
  });

  describe('info', () => {
    it('should print info message', () => {
      output.info('Info message');
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Info message');
    });
  });

  describe('spinner', () => {
    it('should create spinner', () => {
      const spinner = output.spinner('Loading...');
      expect(spinner).toBeDefined();
      expect(spinner['text']).toBe('Loading...');
    });

    it('should start spinner', async () => {
      const spinner = output.spinner('Loading...');
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      
      spinner.start();
      
      // Wait a bit for interval to fire
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(writeSpy).toHaveBeenCalled();
      spinner.stop();
      writeSpy.mockRestore();
    });

    it('should stop spinner with success', () => {
      const spinner = output.spinner('Loading...');
      spinner.start();
      spinner.stop(true);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should stop spinner with failure', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spinner = output.spinner('Loading...');
      spinner.start();
      spinner.stop(false);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('should stop spinner with custom message', () => {
      const spinner = output.spinner('Loading...');
      spinner.start();
      spinner.stop(true, 'Custom message');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Custom message'));
    });

    it('should update spinner text', () => {
      const spinner = output.spinner('Loading...');
      spinner.update('New text');
      expect(spinner['text']).toBe('New text');
    });
  });
});

describe('term singleton', () => {
  it('should be instance of TerminalOutput', () => {
    expect(term).toBeInstanceOf(TerminalOutput);
  });

  it('should have all methods', () => {
    expect(typeof term.color).toBe('function');
    expect(typeof term.bold).toBe('function');
    expect(typeof term.dim).toBe('function');
    expect(typeof term.table).toBe('function');
    expect(typeof term.list).toBe('function');
    expect(typeof term.keyValue).toBe('function');
    expect(typeof term.success).toBe('function');
    expect(typeof term.error).toBe('function');
    expect(typeof term.warn).toBe('function');
    expect(typeof term.info).toBe('function');
    expect(typeof term.spinner).toBe('function');
  });
});
