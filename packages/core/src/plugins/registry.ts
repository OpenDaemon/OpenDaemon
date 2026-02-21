import type { Plugin, RegisteredPlugin } from './types.js';
import {
  ErrorCode,
  PluginError,
} from '../errors/index.js';

/**
 * Dependency graph for plugins
 */
interface DependencyNode {
  name: string;
  plugin: Plugin;
  dependencies: string[];
  dependents: string[];
  visited: boolean;
  visiting: boolean;
}

/**
 * Plugin registry manages plugin lifecycle and dependency resolution.
 *
 * @example
 * ```typescript
 * const registry = new PluginRegistry();
 *
 * // Register plugins
 * registry.register(new ProcessManagerPlugin());
 * registry.register(new HealthCheckPlugin());
 *
 * // Resolve load order
 * const order = registry.resolveLoadOrder();
 *
 * // Install plugins
 * for (const plugin of order) {
 *   await registry.install(plugin, context);
 * }
 * ```
 */
export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private graph = new Map<string, DependencyNode>();

  /**
   * Register a plugin
   *
   * @param plugin - Plugin to register
   * @throws PluginError if plugin is invalid or conflicts exist
   */
  register(plugin: Plugin): void {
    // Validate plugin
    if (!plugin.name) {
      throw new PluginError(
        ErrorCode.PLUGIN_INVALID,
        'unknown',
        'Plugin must have a name'
      );
    }

    if (!plugin.version) {
      throw new PluginError(
        ErrorCode.PLUGIN_INVALID,
        plugin.name,
        'Plugin must have a version'
      );
    }

    // Check for duplicate registration
    if (this.plugins.has(plugin.name)) {
      throw new PluginError(
        ErrorCode.PLUGIN_ALREADY_REGISTERED,
        plugin.name,
        `Plugin "${plugin.name}" is already registered`
      );
    }

    // Check for conflicts
    if (plugin.conflicts) {
      for (const conflict of plugin.conflicts) {
        if (this.plugins.has(conflict)) {
          throw new PluginError(
            ErrorCode.PLUGIN_CONFLICT,
            plugin.name,
            `Plugin "${plugin.name}" conflicts with "${conflict}"`
          );
        }
      }
    }

    // Check if conflicting plugins are already registered
    for (const [name, existing] of this.plugins) {
      if (existing.plugin.conflicts?.includes(plugin.name)) {
        throw new PluginError(
          ErrorCode.PLUGIN_CONFLICT,
          plugin.name,
          `Plugin "${name}" conflicts with "${plugin.name}"`
        );
      }
    }

    // Register plugin
    this.plugins.set(plugin.name, {
      plugin,
      phase: 'installing',
      error: undefined,
    });

    // Build dependency graph
    this.buildGraph();
  }

  /**
   * Unregister a plugin
   *
   * @param name - Plugin name
   * @returns True if plugin was removed
   */
  unregister(name: string): boolean {
    const registered = this.plugins.get(name);
    if (!registered) {
      return false;
    }

    // Check if other plugins depend on this one
    const node = this.graph.get(name);
    if (node?.dependents.length) {
      throw new PluginError(
        ErrorCode.PLUGIN_DEPENDENCY_MISSING,
        name,
        `Cannot unregister "${name}", plugins depend on it: ${node.dependents.join(', ')}`
      );
    }

    this.plugins.delete(name);
    this.graph.delete(name);

    return true;
  }

  /**
   * Get a registered plugin
   *
   * @param name - Plugin name
   * @returns Registered plugin or undefined
   */
  get(name: string): RegisteredPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugins
   *
   * @returns Array of registered plugins
   */
  getAll(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin by name
   *
   * @param name - Plugin name
   * @returns Plugin instance or undefined
   */
  getPlugin<T extends Plugin>(name: string): T | undefined {
    const registered = this.plugins.get(name);
    return registered?.plugin as T | undefined;
  }

  /**
   * Check if a plugin is registered
   *
   * @param name - Plugin name
   * @returns True if registered
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Update plugin phase
   *
   * @param name - Plugin name
   * @param phase - New phase
   */
  setPhase(name: string, phase: RegisteredPlugin['phase']): void {
    const registered = this.plugins.get(name);
    if (registered) {
      registered.phase = phase;
    }
  }

  /**
   * Resolve plugin load order based on dependencies and priority
   *
   * @returns Array of plugins in load order
   * @throws PluginError if circular dependencies exist
   */
  resolveLoadOrder(): Plugin[] {
    // Check for missing dependencies
    for (const [name, node] of this.graph) {
      for (const dep of node.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new PluginError(
            ErrorCode.PLUGIN_DEPENDENCY_MISSING,
            name,
            `Plugin "${name}" depends on "${dep}" which is not registered`
          );
        }
      }
    }

    // Topological sort
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) {
        return;
      }

      if (visiting.has(name)) {
        throw new PluginError(
          ErrorCode.PLUGIN_DEPENDENCY_CIRCULAR,
          name,
          `Circular dependency detected involving "${name}"`
        );
      }

      visiting.add(name);

      const node = this.graph.get(name);
      if (node) {
        for (const dep of node.dependencies) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.graph.keys()) {
      visit(name);
    }

    // Sort by priority (stable sort)
    const sorted = order
      .map(name => this.plugins.get(name)!)
      .sort((a, b) => {
        const priorityA = a.plugin.priority ?? 100;
        const priorityB = b.plugin.priority ?? 100;
        return priorityA - priorityB;
      });

    return sorted.map(r => r.plugin);
  }

  /**
   * Build dependency graph
   */
  private buildGraph(): void {
    this.graph.clear();

    // Create nodes
    for (const [name, registered] of this.plugins) {
      const node: DependencyNode = {
        name,
        plugin: registered.plugin,
        dependencies: [...(registered.plugin.dependencies ?? [])],
        dependents: [],
        visited: false,
        visiting: false,
      };
      this.graph.set(name, node);
    }

    // Link dependents
    for (const [name, node] of this.graph) {
      for (const dep of node.dependencies) {
        const depNode = this.graph.get(dep);
        if (depNode) {
          depNode.dependents.push(name);
        }
      }
    }
  }

  /**
   * Get the number of registered plugins
   */
  size(): number {
    return this.plugins.size;
  }

  /**
   * Clear all plugins
   */
  clear(): void {
    this.plugins.clear();
    this.graph.clear();
  }
}
