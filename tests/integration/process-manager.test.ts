import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';
import { resolve } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

describe('ProcessManagerPlugin', () => {
  let plugin: ProcessManagerPlugin;
  let context: PluginContext;
  let events: EventBus;
  let store: StateStore;
  const testScriptPath = resolve('./test-process.js');

  beforeEach(() => {
    // Create test script
    writeFileSync(
      testScriptPath,
      `setInterval(() => {}, 1000);\nconsole.log('Test process started');`
    );

    events = new EventBus();
    store = new StateStore();
    
    context = {
      config: {},
      pluginConfig: undefined,
      events,
      logger: new Logger('test'),
      store,
      registerMethod: () => {},
      registerHook: () => {},
      getPlugin: () => undefined,
      registerMetric: () => {},
    };

    plugin = new ProcessManagerPlugin();
    plugin.install(context);
  });

  afterEach(async () => {
    // Clean up
    if (existsSync(testScriptPath)) {
      unlinkSync(testScriptPath);
    }
    
    // Stop plugin
    try {
      await plugin.onStop();
    } catch {
      // Ignore
    }
  });

  describe('lifecycle', () => {
    it('should install', () => {
      expect(plugin.name).toBe('process-manager');
    });

    it('should start and load processes from config', async () => {
      const startedProcesses: string[] = [];
      events.on('process:started', (data: unknown) => {
        const d = data as { name: string };
        startedProcesses.push(d.name);
      });

      const configContext = {
        ...context,
        config: {
          apps: [
            {
              name: 'test-app',
              script: testScriptPath,
              instances: 1,
            },
          ],
        },
      };

      await plugin.onStart(configContext);
      
      // Wait for process to start
      await new Promise((r) => setTimeout(r, 500));
      
      expect(startedProcesses).toContain('test-app');
    });
  });
});
