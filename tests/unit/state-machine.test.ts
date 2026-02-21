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
});
