import { describe, it, expect, vi } from 'vitest';
import { StateStore } from '../../packages/core/src/state-store.js';

describe('StateStore', () => {
  describe('basic operations', () => {
    it('should get and set values', () => {
      const store = new StateStore();

      store.set('key', 'value');

      expect(store.get('key')).toBe('value');
    });

    it('should return undefined for missing keys', () => {
      const store = new StateStore();

      expect(store.get('missing')).toBeUndefined();
    });

    it('should check if key exists', () => {
      const store = new StateStore();

      expect(store.has('key')).toBe(false);

      store.set('key', 'value');

      expect(store.has('key')).toBe(true);
    });

    it('should delete keys', () => {
      const store = new StateStore();

      store.set('key', 'value');
      expect(store.has('key')).toBe(true);

      store.delete('key');

      expect(store.has('key')).toBe(false);
    });
  });

  describe('subscriptions', () => {
    it('should notify subscribers on change', () => {
      const store = new StateStore();
      const handler = vi.fn();

      store.subscribe('key', handler);
      store.set('key', 'value');

      expect(handler).toHaveBeenCalledWith('value', undefined);
    });

    it('should provide old value', () => {
      const store = new StateStore();
      const handler = vi.fn();

      store.set('key', 'old');
      store.subscribe('key', handler);
      store.set('key', 'new');

      expect(handler).toHaveBeenCalledWith('new', 'old');
    });

    it('should support unsubscription', () => {
      const store = new StateStore();
      const handler = vi.fn();

      const unsubscribe = store.subscribe('key', handler);
      unsubscribe();

      store.set('key', 'value');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should notify on delete', () => {
      const store = new StateStore();
      const handler = vi.fn();

      store.set('key', 'value');
      store.subscribe('key', handler);
      store.delete('key');

      expect(handler).toHaveBeenCalledWith(undefined, 'value');
    });
  });

  describe('getOrDefault', () => {
    it('should return value when exists', () => {
      const store = new StateStore();

      store.set('key', 'value');

      expect(store.getOrDefault('key', 'default')).toBe('value');
    });

    it('should return default when missing', () => {
      const store = new StateStore();

      expect(store.getOrDefault('key', 'default')).toBe('default');
    });
  });

  describe('update', () => {
    it('should update value using updater function', () => {
      const store = new StateStore();

      store.set('counter', 0);
      store.update('counter', (old) => (old ?? 0) + 1);

      expect(store.get('counter')).toBe(1);
    });
  });

  describe('keys and size', () => {
    it('should return all keys', () => {
      const store = new StateStore();

      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);

      expect(store.keys()).toEqual(['a', 'b', 'c']);
    });

    it('should return correct size', () => {
      const store = new StateStore();

      expect(store.size()).toBe(0);

      store.set('a', 1);
      expect(store.size()).toBe(1);

      store.set('b', 2);
      expect(store.size()).toBe(2);

      store.delete('a');
      expect(store.size()).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all data', () => {
      const store = new StateStore();

      store.set('a', 1);
      store.set('b', 2);

      store.clear();

      expect(store.size()).toBe(0);
      expect(store.has('a')).toBe(false);
    });

    it('should notify subscribers', () => {
      const store = new StateStore();
      const handler = vi.fn();

      store.set('key', 'value');
      store.subscribe('key', handler);
      store.clear();

      expect(handler).toHaveBeenCalledWith(undefined, 'value');
    });
  });

  describe('toObject', () => {
    it('should convert to plain object', () => {
      const store = new StateStore();

      store.set('a', 1);
      store.set('b', 'two');
      store.set('c', { nested: true });

      expect(store.toObject()).toEqual({
        a: 1,
        b: 'two',
        c: { nested: true },
      });
    });

    it('should return empty object for empty store', () => {
      const store = new StateStore();

      expect(store.toObject()).toEqual({});
    });
  });

  describe('edge cases', () => {
    it('should handle deleting non-existent key', () => {
      const store = new StateStore();
      const handler = vi.fn();

      // Subscribe to a key that doesn't exist
      store.subscribe('nonexistent', handler);
      // Delete it - should not throw and should not notify
      store.delete('nonexistent');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle updating non-existent key', () => {
      const store = new StateStore();
      const handler = vi.fn();

      store.subscribe('counter', handler);
      store.update('counter', (old) => (old ?? 0) + 1);

      expect(store.get('counter')).toBe(1);
      expect(handler).toHaveBeenCalledWith(1, undefined);
    });

    it('should handle setting same value', () => {
      const store = new StateStore();
      const handler = vi.fn();

      store.set('key', 'value');
      store.subscribe('key', handler);
      // Set same value again
      store.set('key', 'value');

      // Should still notify
      expect(handler).toHaveBeenCalledWith('value', 'value');
    });

    it('should handle clearing empty store', () => {
      const store = new StateStore();

      // Should not throw
      expect(() => store.clear()).not.toThrow();
      expect(store.size()).toBe(0);
    });

    it('should handle multiple subscribers', () => {
      const store = new StateStore();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      store.subscribe('key', handler1);
      store.subscribe('key', handler2);
      store.set('key', 'value');

      expect(handler1).toHaveBeenCalledWith('value', undefined);
      expect(handler2).toHaveBeenCalledWith('value', undefined);
    });

    it('should handle unsubscribe from non-existent subscription', () => {
      const store = new StateStore();
      const handler = vi.fn();

      const unsubscribe = store.subscribe('key', handler);
      // Unsubscribe multiple times - should not throw
      unsubscribe();
      unsubscribe();

      store.set('key', 'value');
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
