/**
 * Event handler function type
 */
export type EventHandler = (data: unknown) => void | Promise<void>;

/**
 * Unsubscribe function type
 */
export type Unsubscribe = () => void;

/**
 * Wildcard handler with event name
 */
export type WildcardHandler = (event: string, data: unknown) => void | Promise<void>;

/**
 * Event subscription with pattern matching
 */
interface Subscription {
  pattern: string;
  handler: EventHandler;
  isWildcard: boolean;
  regex: RegExp | undefined;
}

/**
 * Typed event bus for inter-plugin communication.
 * Supports wildcards, namespaces, and async handlers.
 *
 * @example
 * ```typescript
 * const events = new EventBus();
 *
 * // Subscribe to specific event
 * events.on('process:started', (data) => {
 *   console.log('Process started:', data);
 * });
 *
 * // Subscribe to wildcard
 * events.on('process:*', (data) => {
 *   console.log('Any process event:', data);
 * });
 *
 * // Emit event
 * events.emit('process:started', { name: 'app' });
 * ```
 */
export class EventBus {
  private subscriptions = new Map<string, Set<Subscription>>();
  private onceSubscriptions = new Map<string, Set<Subscription>>();
  private wildcardSubscriptions = new Set<Subscription>();

  /**
   * Subscribe to an event
   *
   * @param event - Event name or pattern (supports wildcards like "process:*")
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  on(event: string, handler: EventHandler): Unsubscribe {
    const subscription = this.createSubscription(event, handler);

    if (subscription.isWildcard) {
      this.wildcardSubscriptions.add(subscription);
    } else {
      const subs = this.subscriptions.get(event) ?? new Set();
      subs.add(subscription);
      this.subscriptions.set(event, subs);
    }

    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once, then auto-unsubscribe
   *
   * @param event - Event name or pattern
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  once(event: string, handler: EventHandler): Unsubscribe {
    const subscription = this.createSubscription(event, handler);

    if (subscription.isWildcard) {
      const wrappedHandler: EventHandler = data => {
        this.wildcardSubscriptions.delete(subscription);
        return handler(data);
      };
      const wrappedSub = { ...subscription, handler: wrappedHandler };
      this.wildcardSubscriptions.add(wrappedSub);
    } else {
      const subs = this.onceSubscriptions.get(event) ?? new Set();
      subs.add(subscription);
      this.onceSubscriptions.set(event, subs);
    }

    return () => this.off(event, handler);
  }

  /**
   * Emit an event to all subscribers synchronously
   *
   * @param event - Event name
   * @param data - Event data
   */
  emit(event: string, data?: unknown): void {
    // Exact matches
    const subscriptions = this.subscriptions.get(event);
    if (subscriptions) {
      for (const sub of subscriptions) {
        try {
          void sub.handler(data);
        } catch (err) {
          console.error(`Error in event handler for ${event}:`, err);
        }
      }
    }

    // Once subscriptions
    const onceSubs = this.onceSubscriptions.get(event);
    if (onceSubs) {
      for (const sub of onceSubs) {
        try {
          void sub.handler(data);
        } catch (err) {
          console.error(`Error in once event handler for ${event}:`, err);
        }
      }
      this.onceSubscriptions.delete(event);
    }

    // Wildcard matches
    for (const sub of this.wildcardSubscriptions) {
      if (sub.regex?.test(event)) {
        try {
          void sub.handler(data);
        } catch (err) {
          console.error(`Error in wildcard event handler for ${event}:`, err);
        }
      }
    }
  }

  /**
   * Emit an event and wait for all async handlers to complete
   *
   * @param event - Event name
   * @param data - Event data
   * @returns Promise that resolves when all handlers complete
   */
  async emitAsync(event: string, data?: unknown): Promise<void> {
    const promises: Array<Promise<void> | void> = [];

    // Exact matches
    const subscriptions = this.subscriptions.get(event);
    if (subscriptions) {
      for (const sub of subscriptions) {
        promises.push(
          Promise.resolve(sub.handler(data)).catch(err => {
            console.error(`Error in async event handler for ${event}:`, err);
          })
        );
      }
    }

    // Once subscriptions
    const onceSubs = this.onceSubscriptions.get(event);
    if (onceSubs) {
      for (const sub of onceSubs) {
        promises.push(
          Promise.resolve(sub.handler(data)).catch(err => {
            console.error(`Error in async once event handler for ${event}:`, err);
          })
        );
      }
      this.onceSubscriptions.delete(event);
    }

    // Wildcard matches
    for (const sub of this.wildcardSubscriptions) {
      if (sub.regex?.test(event)) {
        promises.push(
          Promise.resolve(sub.handler(data)).catch(err => {
            console.error(`Error in async wildcard handler for ${event}:`, err);
          })
        );
      }
    }

    await Promise.all(promises);
  }

  /**
   * Remove event listener(s)
   *
   * @param event - Event name or pattern
   * @param handler - Optional specific handler to remove (removes all if not provided)
   */
  off(event: string, handler?: EventHandler): void {
    if (handler === undefined) {
      // Remove all handlers for this event
      this.subscriptions.delete(event);
      this.onceSubscriptions.delete(event);

      // Remove wildcard subscriptions matching this pattern
      const pattern = this.createSubscription(event, () => {});
      if (pattern.isWildcard) {
        for (const sub of this.wildcardSubscriptions) {
          if (sub.pattern === event) {
            this.wildcardSubscriptions.delete(sub);
          }
        }
      }
      return;
    }

    // Remove specific handler
    const subs = this.subscriptions.get(event);
    if (subs) {
      for (const sub of subs) {
        if (sub.handler === handler) {
          subs.delete(sub);
          break;
        }
      }
      if (subs.size === 0) {
        this.subscriptions.delete(event);
      }
    }

    // Check once subscriptions
    const onceSubs = this.onceSubscriptions.get(event);
    if (onceSubs) {
      for (const sub of onceSubs) {
        if (sub.handler === handler) {
          onceSubs.delete(sub);
          break;
        }
      }
      if (onceSubs.size === 0) {
        this.onceSubscriptions.delete(event);
      }
    }

    // Check wildcard subscriptions
    for (const sub of this.wildcardSubscriptions) {
      if (sub.pattern === event && sub.handler === handler) {
        this.wildcardSubscriptions.delete(sub);
        break;
      }
    }
  }

  /**
   * Get the number of listeners for an event
   *
   * @param event - Event name
   * @returns Number of listeners
   */
  listenerCount(event: string): number {
    let count = 0;

    // Exact matches
    const subs = this.subscriptions.get(event);
    if (subs) {
      count += subs.size;
    }

    // Once subscriptions
    const onceSubs = this.onceSubscriptions.get(event);
    if (onceSubs) {
      count += onceSubs.size;
    }

    // Wildcard matches
    for (const sub of this.wildcardSubscriptions) {
      if (sub.regex?.test(event)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.subscriptions.clear();
    this.onceSubscriptions.clear();
    this.wildcardSubscriptions.clear();
  }

  /**
   * Create a subscription object from pattern
   */
  private createSubscription(event: string, handler: EventHandler): Subscription {
    const isWildcard = event.includes('*');

    let regex: RegExp | undefined;
    if (isWildcard) {
      // Convert pattern to regex
      // "process:*" becomes /^process:.*$/
      // "*" becomes /^.*$/
      const pattern = event
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      regex = new RegExp(`^${pattern}$`);
    }

    return {
      pattern: event,
      handler,
      isWildcard,
      regex,
    };
  }
}
