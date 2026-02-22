import { describe, it, expect } from 'vitest';
import {
  DaemonError,
  ProcessError,
  ConfigError,
  PluginError,
  ErrorCode,
  assert,
  createError,
} from '../../packages/core/src/errors/index.js';

describe('Error System', () => {
  describe('DaemonError', () => {
    it('should create error with code and message', () => {
      const error = new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon is not running'
      );

      expect(error.code).toBe(ErrorCode.DAEMON_NOT_RUNNING);
      expect(error.message).toBe('Daemon is not running');
      expect(error.name).toBe('DaemonError');
    });

    it('should include context', () => {
      const error = new DaemonError(
        ErrorCode.PROCESS_NOT_FOUND,
        'Process not found',
        { processName: 'my-app' }
      );

      expect(error.context).toEqual({ processName: 'my-app' });
    });

    it('should include cause', () => {
      const cause = new Error('Original error');
      const error = new DaemonError(
        ErrorCode.PROCESS_START_FAILED,
        'Failed to start process',
        undefined,
        cause
      );

      expect(error.cause).toBe(cause);
    });

    it('should serialize cause in toJSON (lines 113-116)', () => {
      const cause = new Error('Original error');
      cause.name = 'OriginalError';
      const error = new DaemonError(
        ErrorCode.PROCESS_START_FAILED,
        'Failed to start process',
        undefined,
        cause
      );

      const json = error.toJSON();
      expect(json.cause).toEqual({
        name: 'OriginalError',
        message: 'Original error',
      });
    });

    it('should convert to JSON', () => {
      const error = new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Test error',
        { key: 'value' }
      );

      const json = error.toJSON();

      expect(json.name).toBe('DaemonError');
      expect(json.code).toBe(ErrorCode.DAEMON_NOT_RUNNING);
      expect(json.message).toBe('Test error');
      expect(json.context).toEqual({ key: 'value' });
    });
  });

  describe('ProcessError', () => {
    it('should include process name', () => {
      const error = new ProcessError(
        ErrorCode.PROCESS_NOT_FOUND,
        'my-app',
        'Process not found'
      );

      expect(error.processName).toBe('my-app');
      expect(error.context).toEqual({ processName: 'my-app' });
    });
  });

  describe('ConfigError', () => {
    it('should include config path', () => {
      const error = new ConfigError(
        ErrorCode.CONFIG_NOT_FOUND,
        'Config not found',
        '/path/to/config.ts'
      );

      expect(error.configPath).toBe('/path/to/config.ts');
    });
  });

  describe('PluginError', () => {
    it('should include plugin name', () => {
      const error = new PluginError(
        ErrorCode.PLUGIN_NOT_FOUND,
        'my-plugin',
        'Plugin not found'
      );

      expect(error.pluginName).toBe('my-plugin');
    });
  });

  describe('assert', () => {
    it('should not throw when condition is true', () => {
      expect(() => {
        assert(true, ErrorCode.INVALID_ARGUMENT, 'Should not throw');
      }).not.toThrow();
    });

    it('should throw when condition is false', () => {
      expect(() => {
        assert(false, ErrorCode.INVALID_ARGUMENT, 'Invalid argument');
      }).toThrow(DaemonError);
    });

    it('should include context in error', () => {
      expect(() => {
        assert(false, ErrorCode.INVALID_ARGUMENT, 'Invalid', { field: 'name' });
      }).toThrow(/Invalid/);
    });
  });

  describe('createError', () => {
    it('should return DaemonError as-is', () => {
      const original = new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Original'
      );
      const result = createError(original);

      expect(result).toBe(original);
    });

    it('should wrap Error', () => {
      const original = new Error('Something went wrong');
      const result = createError(original);

      expect(result).toBeInstanceOf(DaemonError);
      expect(result.message).toBe('Something went wrong');
      expect(result.cause).toBe(original);
    });

    it('should convert string to error', () => {
      const result = createError('Something went wrong');

      expect(result).toBeInstanceOf(DaemonError);
      expect(result.message).toBe('Something went wrong');
    });

    it('should use default code', () => {
      const result = createError('Error');

      expect(result.code).toBe(ErrorCode.UNKNOWN_ERROR);
    });

    it('should use provided default code', () => {
      const result = createError('Error', ErrorCode.TIMEOUT);

      expect(result.code).toBe(ErrorCode.TIMEOUT);
    });
  });
});
