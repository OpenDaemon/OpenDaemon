import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../packages/core/src/event-bus.js';

describe('EventBus', () => {
  describe('basic subscription', () => {
    it('should receive emitted events', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('test', handler);
      bus.emit('test', { data: 123 });

      expect(handler).toHaveBeenCalledWith({ data: 123 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should receive multiple events', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('test', handler);
      bus.emit('test', 1);
      bus.emit('test', 2);
      bus.emit('test', 3);

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should not receive events after unsubscribe', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const unsubscribe = bus.on('test', handler);
      bus.emit('test', 1);
      unsubscribe();
      bus.emit('test', 2);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(1);
    });
  });

  describe('wildcard subscription', () => {
    it('should match wildcard patterns', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('process:*', handler);
      bus.emit('process:start', { name: 'app' });
      bus.emit('process:stop', { name: 'app' });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should match all events with *', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('*', handler);
      bus.emit('event1');
      bus.emit('event2');
      bus.emit('namespace:event3');

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should not match non-matching patterns', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('process:*', handler);
      bus.emit('other:start');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('once subscription', () => {
    it('should only receive one event', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.once('test', handler);
      bus.emit('test', 1);
      bus.emit('test', 2);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(1);
    });
  });

  describe('emitAsync', () => {
    it('should wait for async handlers', async () => {
      const bus = new EventBus();
      const results: number[] = [];

      bus.on('test', async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(data as number);
      });

      bus.on('test', async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push((data as number) * 2);
      });

      await bus.emitAsync('test', 5);

      expect(results).toContain(5);
      expect(results).toContain(10);
    });
  });

  describe('listenerCount', () => {
    it('should return correct listener count', () => {
      const bus = new EventBus();

      expect(bus.listenerCount('test')).toBe(0);

      const unsub1 = bus.on('test', () => {});
      expect(bus.listenerCount('test')).toBe(1);

      const unsub2 = bus.on('test', () => {});
      expect(bus.listenerCount('test')).toBe(2);

      unsub1();
      expect(bus.listenerCount('test')).toBe(1);

      unsub2();
      expect(bus.listenerCount('test')).toBe(0);
    });

    it('should include wildcard listeners', () => {
      const bus = new EventBus();

      bus.on('*', () => {});
      expect(bus.listenerCount('test')).toBe(1);

      bus.on('test', () => {});
      expect(bus.listenerCount('test')).toBe(2);
    });
  });

  describe('off', () => {
    it('should remove all listeners when no handler specified', () => {
      const bus = new EventBus();

      bus.on('test', () => {});
      bus.on('test', () => {});
      expect(bus.listenerCount('test')).toBe(2);

      bus.off('test');
      expect(bus.listenerCount('test')).toBe(0);
    });

    it('should remove only specified handler', () => {
      const bus = new EventBus();
      const handler1 = () => {};
      const handler2 = () => {};

      bus.on('test', handler1);
      bus.on('test', handler2);
      expect(bus.listenerCount('test')).toBe(2);

      bus.off('test', handler1);
      expect(bus.listenerCount('test')).toBe(1);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners', () => {
      const bus = new EventBus();

      bus.on('test1', () => {});
      bus.on('test2', () => {});
      bus.on('*', () => {});

      bus.removeAllListeners();

      expect(bus.listenerCount('test1')).toBe(0);
      expect(bus.listenerCount('test2')).toBe(0);
      expect(bus.listenerCount('other')).toBe(0);
    });
  });
});
