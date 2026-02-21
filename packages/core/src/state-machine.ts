/**
 * State transition configuration
 */
export interface StateTransition<S extends string, E extends string> {
  from: S;
  event: E;
  to: S;
}

/**
 * State machine configuration
 */
export interface StateMachineConfig<S extends string, E extends string> {
  initial: S;
  transitions: Array<StateTransition<S, E>>;
}

/**
 * Transition hook function type
 */
export type TransitionHook<S extends string, E extends string> = (
  from: S,
  to: S,
  event: E
) => void | Promise<void>;

/**
 * Generic state machine implementation.
 * Manages state transitions with validation and hooks.
 *
 * @example
 * ```typescript
 * const machine = new StateMachine({
 *   initial: 'idle',
 *   transitions: [
 *     { from: 'idle', event: 'start', to: 'running' },
 *     { from: 'running', event: 'stop', to: 'idle' },
 *   ],
 * });
 *
 * machine.transition('start'); // Returns true, state is now 'running'
 * machine.transition('stop');  // Returns true, state is now 'idle'
 * ```
 */
export class StateMachine<S extends string, E extends string> {
  private currentState: S;
  private transitions: Map<S, Map<E, S>>;
  private beforeHooks: Array<TransitionHook<S, E>> = [];
  private afterHooks: Array<TransitionHook<S, E>> = [];

  /**
   * Create a new state machine
   *
   * @param config - State machine configuration
   */
  constructor(config: StateMachineConfig<S, E>) {
    this.currentState = config.initial;
    this.transitions = this.buildTransitionMap(config.transitions);
  }

  /**
   * Get the current state
   *
   * @returns Current state
   */
  getState(): S {
    return this.currentState;
  }

  /**
   * Check if a transition is valid from current state
   *
   * @param event - Event to check
   * @returns True if transition is valid
   */
  can(event: E): boolean {
    const fromTransitions = this.transitions.get(this.currentState);
    if (!fromTransitions) {
      return false;
    }
    return fromTransitions.has(event);
  }

  /**
   * Get list of valid events from current state
   *
   * @returns Array of valid event names
   */
  getValidEvents(): E[] {
    const fromTransitions = this.transitions.get(this.currentState);
    if (!fromTransitions) {
      return [];
    }
    return Array.from(fromTransitions.keys());
  }

  /**
   * Perform a state transition
   *
   * @param event - Event triggering the transition
   * @returns True if transition succeeded, false if invalid
   */
  async transition(event: E): Promise<boolean> {
    const fromTransitions = this.transitions.get(this.currentState);
    if (!fromTransitions) {
      return false;
    }

    const toState = fromTransitions.get(event);
    if (toState === undefined) {
      return false;
    }

    const fromState = this.currentState;

    // Run before hooks
    for (const hook of this.beforeHooks) {
      await hook(fromState, toState, event);
    }

    // Perform transition
    this.currentState = toState;

    // Run after hooks
    for (const hook of this.afterHooks) {
      await hook(fromState, toState, event);
    }

    return true;
  }

  /**
   * Force a state change without checking transitions (use with caution)
   *
   * @param state - New state to set
   */
  forceState(state: S): void {
    this.currentState = state;
  }

  /**
   * Register a hook to run before state transitions
   *
   * @param hook - Hook function
   * @returns Unregister function
   */
  beforeTransition(hook: TransitionHook<S, E>): () => void {
    this.beforeHooks.push(hook);
    return () => {
      const index = this.beforeHooks.indexOf(hook);
      if (index > -1) {
        this.beforeHooks.splice(index, 1);
      }
    };
  }

  /**
   * Register a hook to run after state transitions
   *
   * @param hook - Hook function
   * @returns Unregister function
   */
  afterTransition(hook: TransitionHook<S, E>): () => void {
    this.afterHooks.push(hook);
    return () => {
      const index = this.afterHooks.indexOf(hook);
      if (index > -1) {
        this.afterHooks.splice(index, 1);
      }
    };
  }

  /**
   * Check if machine is in a specific state
   *
   * @param state - State to check
   * @returns True if in the specified state
   */
  is(state: S): boolean {
    return this.currentState === state;
  }

  /**
   * Build transition map from configuration
   */
  private buildTransitionMap(
    transitions: Array<StateTransition<S, E>>
  ): Map<S, Map<E, S>> {
    const map = new Map<S, Map<E, S>>();

    for (const { from, event, to } of transitions) {
      let fromMap = map.get(from);
      if (!fromMap) {
        fromMap = new Map<E, S>();
        map.set(from, fromMap);
      }
      fromMap.set(event, to);
    }

    return map;
  }
}
