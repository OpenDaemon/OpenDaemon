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

  describe('rpc methods', () => {
    type Method = (params: unknown) => Promise<unknown>;
    const methods = new Map<string, Method>();
    const stubbornScriptPath = resolve('./test-stubborn-process.js');

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    beforeEach(() => {
      writeFileSync(
        stubbornScriptPath,
        `process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);`
      );

      methods.clear();
      plugin = new ProcessManagerPlugin();
      plugin.install({
        ...context,
        registerMethod: (name: string, handler: Method) => {
          methods.set(name, handler);
        },
      });
    });

    afterEach(() => {
      if (existsSync(stubbornScriptPath)) {
        unlinkSync(stubbornScriptPath);
      }
    });

    it('should force-kill a process that ignores SIGTERM once killTimeout elapses', async () => {
      const info = await methods.get('start')!({
        name: 'stubborn',
        script: stubbornScriptPath,
        killTimeout: 300,
      }) as { pid: number };
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(info.pid)).toBe(true);

      await methods.get('stop')!({ name: 'stubborn' });
      await new Promise((r) => setTimeout(r, 200));

      expect(isAlive(info.pid)).toBe(false);
    });

    it('should not auto-restart a process that was stopped explicitly', async () => {
      await methods.get('start')!({
        name: 'always',
        script: testScriptPath,
        autoRestart: 'always',
        restartDelay: 50,
      });
      await new Promise((r) => setTimeout(r, 300));

      await methods.get('stop')!({ name: 'always' });
      await new Promise((r) => setTimeout(r, 300));

      const info = await methods.get('info')!({ name: 'always' }) as { status: string; restartCount: number };
      expect(info.status).toBe('stopped');
      expect(info.restartCount).toBe(0);
    });

    it.runIf(process.platform === 'linux')('should report the child\'s own memory and CPU, not the daemon\'s', async () => {
      const busyScriptPath = resolve('./test-busy-process.js');
      writeFileSync(
        busyScriptPath,
        `const big = Buffer.alloc(64 * 1024 * 1024, 1);\n` +
        `setInterval(() => { const end = Date.now() + 60; while (Date.now() < end) {} big[0]++; }, 100);`
      );

      try {
        await methods.get('start')!({ name: 'busy', script: busyScriptPath, killTimeout: 300 });
        // One baseline sample at start plus one interval sample 2s later
        await new Promise((r) => setTimeout(r, 2500));

        const info = await methods.get('info')!({ name: 'busy' }) as { cpu: number; memory: number };
        expect(info.memory).toBeGreaterThan(64 * 1024 * 1024);
        expect(info.cpu).toBeGreaterThan(20);
        expect(info.cpu).toBeLessThan(100);
      } finally {
        await methods.get('stop')!({ name: 'busy' });
        unlinkSync(busyScriptPath);
      }
    });

    describe('minUptime readiness', () => {
      const scripts: string[] = [];
      const script = (name: string, body: string) => {
        const path = resolve(`./test-ready-${name}.js`);
        writeFileSync(path, body);
        scripts.push(path);
        return path;
      };

      afterEach(() => {
        for (const path of scripts.splice(0)) {
          if (existsSync(path)) unlinkSync(path);
        }
      });

      it('should treat an app that never sends ready as started once minUptime elapses', async () => {
        const info = await methods.get('start')!({
          name: 'plain', script: script('plain', 'setInterval(() => {}, 1000);'), minUptime: 200, killTimeout: 300,
        }) as { status: string };
        expect(info.status).toBe('online');
        await methods.get('stop')!({ name: 'plain' });
      });

      it('should finish starting as soon as the app sends ready', async () => {
        const started = Date.now();
        await methods.get('start')!({
          name: 'eager', script: script('eager', "process.send('ready'); setInterval(() => {}, 1000);"),
          minUptime: 5000, killTimeout: 300,
        });
        expect(Date.now() - started).toBeLessThan(2000);
        await methods.get('stop')!({ name: 'eager' });
      });

      it('should fail the start when the app exits before minUptime', async () => {
        await expect(methods.get('start')!({
          name: 'crash', script: script('crash', 'process.exit(3);'), minUptime: 2000, autoRestart: 'never',
        })).rejects.toThrow(/exited before it was ready/);
      });

      it('should apply minUptime to every cluster worker', async () => {
        const info = await methods.get('start')!({
          name: 'cluster', script: script('cluster', 'setInterval(() => {}, 1000);'),
          mode: 'cluster', instances: 2, minUptime: 200, killTimeout: 300,
        }) as { status: string; pids: number[] };
        expect(info.status).toBe('online');
        expect(info.pids).toHaveLength(2);
        await methods.get('stop')!({ name: 'cluster' });
      });
    });
  });
});
