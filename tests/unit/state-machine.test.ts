import { describe, it, expect, vi } from 'vitest';
import { StateMachine } from '../../packages/core/src/state-machine.js';

describe('StateMachine', () => {
  type State = 'idle' | 'running' | 'paused' | 'stopped';
  type Event = 'start' | 'pause' | 'resume' | 'stop';

  const createMachine = () =>
    new StateMachine<State, Event>({
      initial: 'idle',
      transitions: [
        { from: 'idle', event: 'start', to: 'running' },
        { from: 'running', event: 'pause', to: 'paused' },
        { from: 'running', event: 'stop', to: 'stopped' },
        { from: 'paused', event: 'resume', to: 'running' },
        { from: 'paused', event: 'stop', to: 'stopped' },
      ],
    });

  describe('initialization', () => {
    it('should start in initial state', () => {
      const machine = createMachine();
      expect(machine.getState()).toBe('idle');
    });
  });

  describe('transitions', () => {
    it('should transition on valid event', async () => {
      const machine = createMachine();

      const result = await machine.transition('start');

      expect(result).toBe(true);
      expect(machine.getState()).toBe('running');
    });

    it('should reject invalid transitions', async () => {
      const machine = createMachine();

      const result = await machine.transition('pause');

      expect(result).toBe(false);
      expect(machine.getState()).toBe('idle');
    });

    it('should handle multiple transitions', async () => {
      const machine = createMachine();

      await machine.transition('start');
      expect(machine.getState()).toBe('running');

      await machine.transition('pause');
      expect(machine.getState()).toBe('paused');

      await machine.transition('resume');
      expect(machine.getState()).toBe('running');

      await machine.transition('stop');
      expect(machine.getState()).toBe('stopped');
    });
  });

  describe('can', () => {
    it('should return true for valid events', () => {
      const machine = createMachine();

      expect(machine.can('start')).toBe(true);
      expect(machine.can('pause')).toBe(false);
    });

    it('should update after transitions', async () => {
      const machine = createMachine();

      expect(machine.can('start')).toBe(true);

      await machine.transition('start');

      expect(machine.can('start')).toBe(false);
      expect(machine.can('pause')).toBe(true);
      expect(machine.can('stop')).toBe(true);
    });
  });

  describe('is', () => {
    it('should check current state', () => {
      const machine = createMachine();

      expect(machine.is('idle')).toBe(true);
      expect(machine.is('running')).toBe(false);
    });
  });

  describe('getValidEvents', () => {
    it('should return valid events for current state', () => {
      const machine = createMachine();

      expect(machine.getValidEvents()).toEqual(['start']);

      machine.transition('start');

      expect(machine.getValidEvents()).toEqual(['pause', 'stop']);
    });
  });

  describe('hooks', () => {
    it('should call beforeTransition hooks', async () => {
      const machine = createMachine();
      const hook = vi.fn();

      machine.beforeTransition(hook);
      await machine.transition('start');

      expect(hook).toHaveBeenCalledWith('idle', 'running', 'start');
    });

    it('should call afterTransition hooks', async () => {
      const machine = createMachine();
      const hook = vi.fn();

      machine.afterTransition(hook);
      await machine.transition('start');

      expect(hook).toHaveBeenCalledWith('idle', 'running', 'start');
    });

    it('should support hook unsubscription', async () => {
      const machine = createMachine();
      const hook = vi.fn();

      const unsubscribe = machine.beforeTransition(hook);
      unsubscribe();

      await machine.transition('start');

      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('forceState', () => {
    it('should force state without transition', () => {
      const machine = createMachine();

      machine.forceState('running');

      expect(machine.getState()).toBe('running');
    });
  });

  describe('edge cases', () => {
    it('should handle multiple beforeTransition hooks', async () => {
      const machine = createMachine();
      const hook1 = vi.fn();
      const hook2 = vi.fn();

      machine.beforeTransition(hook1);
      machine.beforeTransition(hook2);

      await machine.transition('start');

      expect(hook1).toHaveBeenCalled();
      expect(hook2).toHaveBeenCalled();
    });

    it('should handle multiple afterTransition hooks', async () => {
      const machine = createMachine();
      const hook1 = vi.fn();
      const hook2 = vi.fn();

      machine.afterTransition(hook1);
      machine.afterTransition(hook2);

      await machine.transition('start');

      expect(hook1).toHaveBeenCalled();
      expect(hook2).toHaveBeenCalled();
    });

    it('should propagate hook errors', async () => {
      const machine = createMachine();
      const errorHook = vi.fn().mockImplementation(() => {
        throw new Error('Hook error');
      });

      machine.beforeTransition(errorHook);

      // Should throw when hook errors
      await expect(machine.transition('start')).rejects.toThrow('Hook error');
      expect(errorHook).toHaveBeenCalled();
    });

    it('should return empty array for invalid state in getValidEvents', () => {
      const machine = createMachine();
      // Force to a state that has no transitions defined
      machine.forceState('stopped');

      expect(machine.getValidEvents()).toEqual([]);
    });

    it('should return false for can() when no transitions from current state', () => {
      const machine = createMachine();
      // Force to a state that has no transitions defined (lines 79-80)
      machine.forceState('stopped');

      expect(machine.can('start')).toBe(false);
      expect(machine.can('stop')).toBe(false);
    });

    it('should return false for transition() when no transitions from current state', async () => {
      const machine = createMachine();
      // Force to a state that has no transitions defined (lines 106-107)
      machine.forceState('stopped');

      const result = await machine.transition('start');
      expect(result).toBe(false);
    });

    it('should support afterTransition hook unsubscription', async () => {
      const machine = createMachine();
      const hook = vi.fn();

      const unsubscribe = machine.afterTransition(hook);
      unsubscribe();

      await machine.transition('start');

      expect(hook).not.toHaveBeenCalled();
    });

    it('should handle async hooks', async () => {
      const machine = createMachine();
      let resolved = false;

      machine.beforeTransition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        resolved = true;
      });

      await machine.transition('start');

      expect(resolved).toBe(true);
    });
  });
});
