import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry } from '../../packages/core/src/plugins/registry.js';
import { PluginError, ErrorCode } from '../../packages/core/src/errors/index.js';
import type { Plugin } from '../../packages/core/src/plugins/types.js';

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe('registration', () => {
    it('should register plugin', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        install: vi.fn(),
      };

      registry.register(plugin);
      expect(registry.has('test-plugin')).toBe(true);
    });

    it('should throw when registering duplicate plugin', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        install: vi.fn(),
      };

      registry.register(plugin);
      
      expect(() => {
        registry.register(plugin);
      }).toThrow(PluginError);
    });

    it('should throw when plugin has no name', () => {
      const plugin = {
        version: '1.0.0',
        description: 'Test plugin',
        install: vi.fn(),
      } as unknown as Plugin;

      expect(() => {
        registry.register(plugin);
      }).toThrow(PluginError);
    });

    it('should throw when plugin has no version', () => {
      const plugin = {
        name: 'test-plugin',
        description: 'Test plugin',
        install: vi.fn(),
      } as unknown as Plugin;

      expect(() => {
        registry.register(plugin);
      }).toThrow(PluginError);
    });
  });

  describe('conflicts', () => {
    it('should throw when plugin conflicts with existing', () => {
      const plugin1: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        install: vi.fn(),
      };

      const plugin2: Plugin = {
        name: 'plugin-b',
        version: '1.0.0',
        description: 'Plugin B',
        conflicts: ['plugin-a'],
        install: vi.fn(),
      };

      registry.register(plugin1);
      
      expect(() => {
        registry.register(plugin2);
      }).toThrow(PluginError);
    });

    it('should throw when plugin conflicts with existing that declares conflict', () => {
      const plugin1: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        conflicts: ['plugin-b'],
        install: vi.fn(),
      };

      const plugin2: Plugin = {
        name: 'plugin-b',
        version: '1.0.0',
        description: 'Plugin B',
        install: vi.fn(),
      };

      registry.register(plugin1);
      
      expect(() => {
        registry.register(plugin2);
      }).toThrow(PluginError);
    });
  });

  describe('dependencies', () => {
    it('should resolve dependencies', () => {
      const order: string[] = [];

      const pluginA: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        install: vi.fn(),
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        version: '1.0.0',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        install: vi.fn().mockImplementation(() => order.push('b')),
      };

      const pluginC: Plugin = {
        name: 'plugin-c',
        version: '1.0.0',
        description: 'Plugin C',
        dependencies: ['plugin-a'],
        install: vi.fn().mockImplementation(() => order.push('c')),
      };

      registry.register(pluginA);
      registry.register(pluginB);
      registry.register(pluginC);

      const resolved = registry.resolveLoadOrder();
      
      expect(resolved.map(p => p.name)).toContain('plugin-a');
      expect(resolved.map(p => p.name)).toContain('plugin-b');
      expect(resolved.map(p => p.name)).toContain('plugin-c');
      
      // A should come before B and C
      const indexA = resolved.findIndex(p => p.name === 'plugin-a');
      const indexB = resolved.findIndex(p => p.name === 'plugin-b');
      const indexC = resolved.findIndex(p => p.name === 'plugin-c');
      
      expect(indexA).toBeLessThan(indexB);
      expect(indexA).toBeLessThan(indexC);
    });

    it('should throw when dependency is missing', () => {
      const plugin: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        dependencies: ['missing-plugin'],
        install: vi.fn(),
      };

      registry.register(plugin);
      
      expect(() => {
        registry.resolveLoadOrder();
      }).toThrow(PluginError);
    });

    it('should detect circular dependencies', () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        dependencies: ['plugin-b'],
        install: vi.fn(),
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        version: '1.0.0',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        install: vi.fn(),
      };

      registry.register(pluginA);
      registry.register(pluginB);
      
      expect(() => {
        registry.resolveLoadOrder();
      }).toThrow(PluginError);
    });
  });

  describe('priority', () => {
    it('should sort by priority', () => {
      const plugin1: Plugin = {
        name: 'low',
        version: '1.0.0',
        description: 'Low priority',
        priority: 100,
        install: vi.fn(),
      };

      const plugin2: Plugin = {
        name: 'high',
        version: '1.0.0',
        description: 'High priority',
        priority: 10,
        install: vi.fn(),
      };

      registry.register(plugin1);
      registry.register(plugin2);

      const resolved = registry.resolveLoadOrder();
      
      expect(resolved[0].name).toBe('high');
      expect(resolved[1].name).toBe('low');
    });

    it('should use default priority of 100', () => {
      const plugin1: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        install: vi.fn(),
      };

      const plugin2: Plugin = {
        name: 'plugin-b',
        version: '1.0.0',
        description: 'Plugin B',
        install: vi.fn(),
      };

      registry.register(plugin1);
      registry.register(plugin2);

      // With same priority, order depends on registration
      const resolved = registry.resolveLoadOrder();
      expect(resolved).toHaveLength(2);
    });
  });

  describe('getters', () => {
    it('should get plugin', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        install: vi.fn(),
      };

      registry.register(plugin);
      expect(registry.getPlugin('test-plugin')).toBe(plugin);
    });

    it('should get all plugins', () => {
      const plugin1: Plugin = {
        name: 'plugin-1',
        version: '1.0.0',
        description: 'Plugin 1',
        install: vi.fn(),
      };

      const plugin2: Plugin = {
        name: 'plugin-2',
        version: '1.0.0',
        description: 'Plugin 2',
        install: vi.fn(),
      };

      registry.register(plugin1);
      registry.register(plugin2);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
    });

    it('should get size', () => {
      expect(registry.size()).toBe(0);
      
      registry.register({
        name: 'test',
        version: '1.0.0',
        description: 'Test',
        install: vi.fn(),
      });
      
      expect(registry.size()).toBe(1);
    });
  });

  describe('unregistration', () => {
    it('should unregister plugin', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        install: vi.fn(),
      };

      registry.register(plugin);
      expect(registry.has('test-plugin')).toBe(true);
      
      const result = registry.unregister('test-plugin');
      expect(result).toBe(true);
      expect(registry.has('test-plugin')).toBe(false);
    });

    it('should return false when unregistering non-existent plugin', () => {
      const result = registry.unregister('non-existent');
      expect(result).toBe(false);
    });

    it('should throw when unregistering plugin with dependents', () => {
      const pluginA: Plugin = {
        name: 'plugin-a',
        version: '1.0.0',
        description: 'Plugin A',
        install: vi.fn(),
      };

      const pluginB: Plugin = {
        name: 'plugin-b',
        version: '1.0.0',
        description: 'Plugin B',
        dependencies: ['plugin-a'],
        install: vi.fn(),
      };

      registry.register(pluginA);
      registry.register(pluginB);

      expect(() => {
        registry.unregister('plugin-a');
      }).toThrow(PluginError);
    });
  });

  describe('phase management', () => {
    it('should set and get phase', () => {
      const plugin: Plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        install: vi.fn(),
      };

      registry.register(plugin);
      
      expect(registry.get('test-plugin')?.phase).toBe('installing');
      
      registry.setPhase('test-plugin', 'ready');
      
      expect(registry.get('test-plugin')?.phase).toBe('ready');
    });
  });

  describe('clear', () => {
    it('should clear all plugins', () => {
      registry.register({
        name: 'plugin-1',
        version: '1.0.0',
        description: 'Plugin 1',
        install: vi.fn(),
      });

      registry.register({
        name: 'plugin-2',
        version: '1.0.0',
        description: 'Plugin 2',
        install: vi.fn(),
      });

      expect(registry.size()).toBe(2);
      
      registry.clear();
      
      expect(registry.size()).toBe(0);
    });
  });
});
