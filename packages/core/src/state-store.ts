/**
 * State subscriber function type
 */
export type StateSubscriber<T> = (value: T, oldValue: T | undefined) => void;

/**
 * In-memory key-value store with subscription support.
 * Used for sharing state between plugins.
 *
 * @example
 * ```typescript
 * const store = new StateStore();
 *
 * // Subscribe to changes
 * const unsubscribe = store.subscribe('counter', (value, oldValue) => {
 *   console.log(`Counter changed from ${oldValue} to ${value}`);
 * });
 *
 * // Set value
 * store.set('counter', 42);
 *
 * // Get value
 * const count = store.get<number>('counter');
 *
 * // Unsubscribe
 * unsubscribe();
 * ```
 */
export class StateStore {
  private data = new Map<string, unknown>();
  private subscribers = new Map<string, Set<StateSubscriber<unknown>>>();

  /**
   * Get a value from the store
   *
   * @param key - Key to retrieve
   * @returns Value or undefined if not found
   */
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  /**
   * Get a value with a default fallback
   *
   * @param key - Key to retrieve
   * @param defaultValue - Default value if key not found
   * @returns Value or default
   */
  getOrDefault<T>(key: string, defaultValue: T): T {
    const value = this.get<T>(key);
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Set a value in the store
   *
   * @param key - Key to set
   * @param value - Value to store
   */
  set<T>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    this.data.set(key, value);

    // Notify subscribers
    const subs = this.subscribers.get(key);
    if (subs) {
      for (const handler of subs) {
        try {
          handler(value, oldValue);
        } catch (err) {
          console.error(`Error in state subscriber for ${key}:`, err);
        }
      }
    }
  }

  /**
   * Check if a key exists in the store
   *
   * @param key - Key to check
   * @returns True if key exists
   */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /**
   * Delete a key from the store
   *
   * @param key - Key to delete
   * @returns True if key existed and was deleted
   */
  delete(key: string): boolean {
    const oldValue = this.get(key);
    const existed = this.data.delete(key);

    if (existed) {
      // Notify subscribers with undefined
      const subs = this.subscribers.get(key);
      if (subs) {
        for (const handler of subs) {
          try {
            handler(undefined, oldValue);
          } catch (err) {
            console.error(`Error in state subscriber for ${key}:`, err);
          }
        }
      }
    }

    return existed;
  }

  /**
   * Subscribe to changes for a specific key
   *
   * @param key - Key to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  subscribe<T>(key: string, handler: StateSubscriber<T>): () => void {
    const subs = this.subscribers.get(key) ?? new Set();
    subs.add(handler as StateSubscriber<unknown>);
    this.subscribers.set(key, subs);

    return () => {
      const currentSubs = this.subscribers.get(key);
      if (currentSubs) {
        currentSubs.delete(handler as StateSubscriber<unknown>);
        if (currentSubs.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  /**
   * Get all keys in the store
   *
   * @returns Array of keys
   */
  keys(): string[] {
    return Array.from(this.data.keys());
  }

  /**
   * Get number of entries in the store
   *
   * @returns Number of entries
   */
  size(): number {
    return this.data.size;
  }

  /**
   * Clear all data from the store
   */
  clear(): void {
    // Notify all subscribers
    for (const [key, subs] of this.subscribers) {
      const oldValue = this.get(key);
      for (const handler of subs) {
        try {
          handler(undefined, oldValue);
        } catch (err) {
          console.error(`Error in state subscriber for ${key}:`, err);
        }
      }
    }

    this.data.clear();
    this.subscribers.clear();
  }

  /**
   * Update a value using an updater function
   *
   * @param key - Key to update
   * @param updater - Function that receives old value and returns new value
   */
  update<T>(key: string, updater: (oldValue: T | undefined) => T): void {
    const oldValue = this.get<T>(key);
    const newValue = updater(oldValue);
    this.set(key, newValue);
  }

  /**
   * Get all entries as an object
   *
   * @returns Object with all key-value pairs
   */
  toObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.data) {
      result[key] = value;
    }
    return result;
  }
}
