import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandParser } from '../../packages/cli/src/parser.js';
import type { CliOption } from '../../packages/cli/src/parser.js';

describe('CommandParser', () => {
  let parser: CommandParser;

  beforeEach(() => {
    parser = new CommandParser();
  });

  describe('basic parsing', () => {
    it('should parse empty args', () => {
      const result = parser.parse([]);
      expect(result.command).toBe('');
      expect(result.subcommand).toBe('');
      expect(result.args).toEqual([]);
    });

    it('should parse command only', () => {
      const result = parser.parse(['start']);
      expect(result.command).toBe('start');
      expect(result.subcommand).toBe('');
    });

    it('should parse command with subcommand', () => {
      const result = parser.parse(['daemon', 'start']);
      expect(result.command).toBe('daemon');
      expect(result.subcommand).toBe('start');
    });

    it('should parse arguments', () => {
      const result = parser.parse(['start', 'app.js', 'arg1', 'arg2']);
      expect(result.command).toBe('start');
      expect(result.args).toEqual(['app.js', 'arg1', 'arg2']);
    });
  });

  describe('long options', () => {
    it('should parse boolean flag', () => {
      parser.addOption({ name: 'verbose', type: 'boolean' } as CliOption);
      const result = parser.parse(['--verbose']);
      expect(result.options['verbose']).toBe(true);
    });

    it('should parse string option', () => {
      parser.addOption({ name: 'name', type: 'string' } as CliOption);
      const result = parser.parse(['--name', 'test']);
      expect(result.options['name']).toBe('test');
    });

    it('should parse option with equals', () => {
      parser.addOption({ name: 'name', type: 'string' } as CliOption);
      const result = parser.parse(['--name=test']);
      expect(result.options['name']).toBe('test');
    });

    it('should parse number option', () => {
      parser.addOption({ name: 'instances', type: 'number' } as CliOption);
      const result = parser.parse(['--instances', '4']);
      expect(result.options['instances']).toBe(4);
    });

    it('should use default value', () => {
      parser.addOption({ name: 'instances', type: 'number', default: 1 } as CliOption);
      const result = parser.parse([]);
      expect(result.options['instances']).toBe(1);
    });
  });

  describe('short options', () => {
    it('should parse single flag', () => {
      parser.addOption({ name: 'verbose', alias: 'v', type: 'boolean' } as CliOption);
      const result = parser.parse(['-v']);
      expect(result.options['verbose']).toBe(true);
    });

    it('should parse combined flags', () => {
      parser.addOption({ name: 'verbose', alias: 'v', type: 'boolean' } as CliOption);
      parser.addOption({ name: 'quiet', alias: 'q', type: 'boolean' } as CliOption);
      const result = parser.parse(['-vq']);
      expect(result.options['verbose']).toBe(true);
      expect(result.options['quiet']).toBe(true);
    });

    it('should parse option with value', () => {
      parser.addOption({ name: 'name', alias: 'n', type: 'string' } as CliOption);
      const result = parser.parse(['-n', 'test']);
      expect(result.options['name']).toBe('test');
    });
  });

  describe('array options', () => {
    it('should parse multiple array values', () => {
      parser.addOption({ name: 'env', type: 'array' } as CliOption);
      const result = parser.parse(['--env', 'A=1', '--env', 'B=2']);
      expect(result.options['env']).toEqual(['A=1', 'B=2']);
    });
  });

  describe('mixed arguments', () => {
    it('should handle options and args together', () => {
      parser.addOption({ name: 'verbose', alias: 'v', type: 'boolean' } as CliOption);
      parser.addOption({ name: 'name', type: 'string' } as CliOption);
      const result = parser.parse(['-v', 'start', 'app.js']);
      expect(result.command).toBe('start');
      expect(result.args).toEqual(['app.js']);
      expect(result.options['verbose']).toBe(true);
    });

    it('should handle global options before command', () => {
      parser.addOption({ name: 'config', alias: 'c', type: 'string' } as CliOption);
      const result = parser.parse(['-c', 'config.json', 'start']);
      expect(result.command).toBe('start');
      expect(result.options['config']).toBe('config.json');
    });
  });

  describe('unknown options', () => {
    it('should treat unknown options as arguments', () => {
      const result = parser.parse(['--unknown-flag']);
      expect(result.args).toContain('--unknown-flag');
    });
  });

  describe('getOptions', () => {
    it('should return all registered options', () => {
      parser.addOption({ name: 'verbose', type: 'boolean' } as CliOption);
      parser.addOption({ name: 'name', type: 'string' } as CliOption);
      const options = parser.getOptions();
      expect(options).toHaveLength(2);
      expect(options[0].name).toBe('verbose');
      expect(options[1].name).toBe('name');
    });
  });
});

// Missing edge case tests

describe('CommandParser edge cases', () => {
  it('should handle option at end without value for non-boolean', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'name', type: 'string' } as CliOption);
    const result = parser.parse(['--name']);
    // When no value provided, treated as boolean flag
    expect(result.options['name']).toBe(true);
  });

  it('should handle negative numbers when quoted', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'offset', type: 'number' } as CliOption);
    const result = parser.parse(['--offset', '-5']);
    // Parser treats -5 as next arg starting with -
    expect(result.args).toContain('-5');
  });

  it('should handle float numbers', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'scale', type: 'number' } as CliOption);
    const result = parser.parse(['--scale', '1.5']);
    expect(result.options['scale']).toBe(1.5);
  });

  it('should handle zero', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'count', type: 'number' } as CliOption);
    const result = parser.parse(['--count', '0']);
    expect(result.options['count']).toBe(0);
  });

  it('should handle option without value for non-boolean as boolean', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'flag', type: 'string' } as CliOption);
    const result = parser.parse(['--flag']);
    expect(result.options['flag']).toBe(true);
  });

  it('should handle array option with single value', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'tags', type: 'array' } as CliOption);
    const result = parser.parse(['--tags', 'tag1']);
    expect(result.options['tags']).toEqual(['tag1']);
  });

  it('should handle option at end of args', () => {
    const parser = new CommandParser();
    parser.addOption({ name: 'verbose', type: 'boolean' } as CliOption);
    const result = parser.parse(['start', 'app.js', '--verbose']);
    expect(result.options['verbose']).toBe(true);
    expect(result.args).toEqual(['app.js']);
  });
});
