import { describe, it, expect } from 'vitest';
import { CommandParser } from '../../packages/cli/src/parser.js';

describe('CommandParser', () => {
  describe('basic parsing', () => {
    it('should parse command', () => {
      const parser = new CommandParser();
      const result = parser.parse(['start', 'app.js']);

      expect(result.command).toBe('start');
      expect(result.args).toEqual(['app.js']);
    });

    it('should parse subcommand', () => {
      const parser = new CommandParser();
      const result = parser.parse(['daemon', 'start']);

      expect(result.command).toBe('daemon');
      expect(result.subcommand).toBe('start');
    });

    it('should handle empty args', () => {
      const parser = new CommandParser();
      const result = parser.parse([]);

      expect(result.command).toBe('');
      expect(result.args).toEqual([]);
    });
  });

  describe('long options', () => {
    it('should parse boolean flag', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'verbose',
        type: 'boolean',
      });

      const result = parser.parse(['--verbose']);

      expect(result.options.verbose).toBe(true);
    });

    it('should parse string option', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'name',
        type: 'string',
      });

      const result = parser.parse(['--name', 'my-app']);

      expect(result.options.name).toBe('my-app');
    });

    it('should parse option with equals', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'name',
        type: 'string',
      });

      const result = parser.parse(['--name=my-app']);

      expect(result.options.name).toBe('my-app');
    });

    it('should parse number option', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'instances',
        type: 'number',
      });

      const result = parser.parse(['--instances', '4']);

      expect(result.options.instances).toBe(4);
    });

    it('should use default value', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'instances',
        type: 'number',
        default: 1,
      });

      const result = parser.parse([]);

      expect(result.options.instances).toBe(1);
    });
  });

  describe('short options', () => {
    it('should parse single flag', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'verbose',
        alias: 'v',
        type: 'boolean',
      });

      const result = parser.parse(['-v']);

      expect(result.options.verbose).toBe(true);
    });

    it('should parse combined flags', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'verbose',
        alias: 'v',
        type: 'boolean',
      });
      parser.addOption({
        name: 'quiet',
        alias: 'q',
        type: 'boolean',
      });

      const result = parser.parse(['-vq']);

      expect(result.options.verbose).toBe(true);
      expect(result.options.quiet).toBe(true);
    });

    it('should parse option with value', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'name',
        alias: 'n',
        type: 'string',
      });

      const result = parser.parse(['-n', 'my-app']);

      expect(result.options.name).toBe('my-app');
    });
  });

  describe('mixed arguments', () => {
    it('should parse command with options and args', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'name',
        alias: 'n',
        type: 'string',
      });
      parser.addOption({
        name: 'verbose',
        alias: 'v',
        type: 'boolean',
      });

      const result = parser.parse([
        'start',
        'app.js',
        '--name',
        'my-app',
        '-v',
      ]);

      expect(result.command).toBe('start');
      expect(result.args).toEqual(['app.js']);
      expect(result.options.name).toBe('my-app');
      expect(result.options.verbose).toBe(true);
    });

    it('should handle options before and after command', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'verbose',
        alias: 'v',
        type: 'boolean',
      });

      const result = parser.parse(['-v', 'start', 'app.js']);

      expect(result.command).toBe('start');
      expect(result.options.verbose).toBe(true);
    });
  });

  describe('array options', () => {
    it('should parse array option', () => {
      const parser = new CommandParser();
      parser.addOption({
        name: 'env',
        type: 'array',
      });

      const result = parser.parse(['--env', 'KEY1=val1', '--env', 'KEY2=val2']);

      expect(result.options.env).toEqual(['KEY1=val1', 'KEY2=val2']);
    });
  });

  describe('unknown options', () => {
    it('should treat unknown options as arguments', () => {
      const parser = new CommandParser();

      const result = parser.parse(['--unknown-flag']);

      expect(result.args).toContain('--unknown-flag');
    });
  });
});
