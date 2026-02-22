import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LogLevel } from '../../packages/core/src/utils/logger.js';

describe('Logger', () => {
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Reset global level
    Logger.setGlobalLevel(LogLevel.INFO);
    Logger.clearHandlers();
    Logger.resetHandlers();
  });

  afterEach(() => {
    consoleDebugSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('basic logging', () => {
    it('should log info message', () => {
      const logger = new Logger('test');
      logger.info('Test message');
      
      expect(consoleInfoSpy).toHaveBeenCalled();
      expect(consoleInfoSpy.mock.calls[0][0]).toContain('Test message');
    });

    it('should log warn message', () => {
      const logger = new Logger('test');
      logger.warn('Warning message');
      
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleWarnSpy.mock.calls[0][0]).toContain('Warning message');
    });

    it('should log error message', () => {
      const logger = new Logger('test');
      logger.error('Error message');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('Error message');
    });

    it('should log trace message', () => {
      Logger.setGlobalLevel(LogLevel.TRACE);
      const logger = new Logger('test');
      logger.trace('Trace message');
      
      expect(consoleDebugSpy).toHaveBeenCalled();
      expect(consoleDebugSpy.mock.calls[0][0]).toContain('Trace message');
    });

    it('should log debug message', () => {
      Logger.setGlobalLevel(LogLevel.DEBUG);
      const logger = new Logger('test');
      logger.debug('Debug message');
      
      expect(consoleDebugSpy).toHaveBeenCalled();
      expect(consoleDebugSpy.mock.calls[0][0]).toContain('Debug message');
    });

    it('should log fatal message', () => {
      const logger = new Logger('test');
      logger.fatal('Fatal message');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('Fatal message');
    });
  });

  describe('log levels', () => {
    it('should respect global log level', () => {
      Logger.setGlobalLevel(LogLevel.WARN);
      const logger = new Logger('test');
      
      logger.info('This should not be logged');
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      
      logger.warn('This should be logged');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should get global log level', () => {
      Logger.setGlobalLevel(LogLevel.DEBUG);
      expect(Logger.getGlobalLevel()).toBe(LogLevel.DEBUG);
    });

    it('should not log below level', () => {
      Logger.setGlobalLevel(LogLevel.ERROR);
      const logger = new Logger('test');
      
      logger.info('Info');
      logger.warn('Warn');
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      
      logger.error('Error');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('log with data', () => {
    it('should log with data object', () => {
      const logger = new Logger('test');
      logger.info('Message with data', { key: 'value' });
      
      expect(consoleInfoSpy).toHaveBeenCalled();
      const callArg = consoleInfoSpy.mock.calls[0][0];
      expect(callArg).toContain('Message with data');
    });

    it('should log with error', () => {
      const logger = new Logger('test');
      const error = new Error('Test error');
      logger.error('Message with error', undefined, error);
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const callArg = consoleErrorSpy.mock.calls[0][0];
      expect(callArg).toContain('Message with error');
    });

    it('should log warn with error', () => {
      const logger = new Logger('test');
      const error = new Error('Warning error');
      logger.warn('Message with warning', { data: 123 }, error);
      
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should log fatal with error', () => {
      const logger = new Logger('test');
      const error = new Error('Fatal error');
      logger.fatal('Fatal message', undefined, error);
      
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('child logger', () => {
    it('should create child logger with namespace', () => {
      const parent = new Logger('parent');
      const child = parent.child('child');
      
      child.info('Child message');
      
      expect(consoleInfoSpy).toHaveBeenCalled();
      expect(consoleInfoSpy.mock.calls[0][0]).toContain('parent:child');
    });
  });

  describe('custom handlers', () => {
    it('should use custom handler', () => {
      const customHandler = vi.fn();
      Logger.addHandler(customHandler);
      
      const logger = new Logger('test');
      logger.info('Test message');
      
      expect(customHandler).toHaveBeenCalled();
      expect(customHandler.mock.calls[0][0]).toMatchObject({
        level: LogLevel.INFO,
        namespace: 'test',
        message: 'Test message',
      });
    });

    it('should clear all handlers', () => {
      const customHandler = vi.fn();
      Logger.addHandler(customHandler);
      Logger.clearHandlers();
      
      const logger = new Logger('test');
      logger.info('Test message');
      
      expect(customHandler).not.toHaveBeenCalled();
    });

    it('should reset to default handlers', () => {
      Logger.clearHandlers();
      Logger.resetHandlers();
      
      const logger = new Logger('test');
      logger.info('Test message');
      
      expect(consoleInfoSpy).toHaveBeenCalled();
    });

    it('should handle handler errors gracefully', () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      Logger.addHandler(errorHandler);
      
      const logger = new Logger('test');
      
      // Should not throw
      expect(() => logger.info('Test')).not.toThrow();
    });
  });

  describe('LogLevel enum', () => {
    it('should have correct values', () => {
      expect(LogLevel.TRACE).toBe(0);
      expect(LogLevel.DEBUG).toBe(1);
      expect(LogLevel.INFO).toBe(2);
      expect(LogLevel.WARN).toBe(3);
      expect(LogLevel.ERROR).toBe(4);
      expect(LogLevel.FATAL).toBe(5);
      expect(LogLevel.SILENT).toBe(6);
    });
  });
});
