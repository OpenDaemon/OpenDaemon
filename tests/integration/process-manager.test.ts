import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';
import { resolve } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { request } from 'http';
import { availableParallelism } from 'os';

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

    it('should emit one process:log entry per line even when lines span output chunks', async () => {
      const chunkedScriptPath = resolve('./test-chunked-process.js');
      writeFileSync(
        chunkedScriptPath,
        "process.stdout.write('hel');\n" +
        "setTimeout(() => process.stdout.write('lo\\nwor'), 50);\n" +
        "setTimeout(() => { process.stdout.write('ld\\r\\n'); process.stderr.write('no newline at exit'); }, 100);\n" +
        "setTimeout(() => process.exit(0), 150);"
      );
      const entries: Array<{ message: string; source: string; level: string; processName: string; pid: number }> = [];
      events.on('process:log', (data: unknown) => { entries.push(data as (typeof entries)[number]); });

      try {
        const info = await methods.get('start')!({ name: 'chunked', script: chunkedScriptPath, autoRestart: 'never' }) as { pid: number };
        await new Promise((r) => setTimeout(r, 600));

        expect(entries.map((e) => [e.source, e.message])).toEqual([
          ['stdout', 'hello'],
          ['stdout', 'world'],
          ['stderr', 'no newline at exit'],
        ]);
        expect(entries[0]).toMatchObject({ level: 'info', processName: 'chunked', pid: info.pid });
        expect(entries[2]?.level).toBe('error');
      } finally {
        unlinkSync(chunkedScriptPath);
      }
    });

    describe('cluster mode', () => {
      const clusterScript = resolve('./test-cluster-app.cjs');
      const logs: Array<{ message: string; instanceId?: number; pid: number }> = [];

      const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        while (!(await predicate())) {
          if (Date.now() > deadline) throw new Error('condition not met');
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const get = (port: number) => new Promise<string>((resolveBody, reject) => {
        request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => { body += c.toString(); });
          res.on('end', () => { resolveBody(body); });
        }).on('error', reject).end();
      });
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

      beforeEach(() => {
        logs.length = 0;
        events.on('process:log', (data: unknown) => { logs.push(data as (typeof logs)[number]); });
        writeFileSync(clusterScript, [
          "const http = require('http');",
          "const server = http.createServer((req, res) => res.end(String(process.pid)));",
          "server.listen(0, '127.0.0.1', () => console.log('port ' + server.address().port));",
        ].join('\n'));
      });

      afterEach(() => {
        if (existsSync(clusterScript)) unlinkSync(clusterScript);
      });

      it('should let all workers share one listening port and tag logs by instance', async () => {
        await methods.get('start')!({ name: 'web', script: clusterScript, mode: 'cluster', instances: 3, killTimeout: 500 });
        await waitFor(() => logs.filter((l) => l.message.startsWith('port ')).length === 3);

        const ports = new Set(logs.map((l) => l.message.split(' ')[1]));
        expect(ports.size).toBe(1);
        expect(logs.map((l) => l.instanceId).sort()).toEqual([0, 1, 2]);

        const port = Number([...ports][0]);
        const servedBy = new Set<string>();
        for (let i = 0; i < 12; i++) servedBy.add(await get(port));
        // node:cluster round-robins everywhere except Windows, where the OS picks the worker
        // (SCHED_NONE) and sequential requests from one client often land on the same one
        if (process.platform !== 'win32') expect(servedBy.size).toBeGreaterThan(1);

        const info = await methods.get('info')!({ name: 'web' }) as { instances: number; runningInstances: number };
        expect(info).toMatchObject({ instances: 3, runningInstances: 3 });
        await methods.get('stop')!({ name: 'web' });
      });

      it('should restart a crashed worker, count it, and leave no workers after stop', async () => {
        await methods.get('start')!({ name: 'web', script: clusterScript, mode: 'cluster', instances: 2, restartDelay: 50, killTimeout: 500 });
        await waitFor(async () => (await methods.get('info')!({ name: 'web' }) as { runningInstances: number }).runningInstances === 2);

        const { pids } = await methods.get('info')!({ name: 'web' }) as { pids: number[] };
        const victim = pids[1]!;
        process.kill(victim, 'SIGKILL');
        await waitFor(async () => {
          const info = await methods.get('info')!({ name: 'web' }) as { runningInstances: number; restartCount: number; pids: number[] };
          return info.restartCount === 1 && info.runningInstances === 2 && !info.pids.includes(victim);
        });

        const before = (await methods.get('info')!({ name: 'web' }) as { pids: number[] }).pids;
        await methods.get('stop')!({ name: 'web' });
        await waitFor(() => before.every((pid) => !alive(pid)), 3000);
      });

      it('should scale a running cluster up and down without restarting it', async () => {
        type Info = { runningInstances: number; instances: number; pids: number[]; restartCount: number; pid: number };
        const info = async () => await methods.get('info')!({ name: 'web' }) as Info;
        const started = await methods.get('start')!({ name: 'web', script: clusterScript, mode: 'cluster', instances: 2, killTimeout: 500 }) as Info;
        await waitFor(async () => (await info()).runningInstances === 2);

        expect(await methods.get('scale')!({ name: 'web', instances: 4 })).toMatchObject({ instances: 4 });
        await waitFor(async () => (await info()).runningInstances === 4);
        const atFour = await info();

        await methods.get('scale')!({ name: 'web', instances: 1 });
        await waitFor(async () => (await info()).runningInstances === 1);
        const atOne = await info();
        // Same primary, retired workers are gone, and retiring them is not a crash restart
        expect(atOne.pid).toBe(started.pid);
        expect(atOne.restartCount).toBe(0);
        const retired = atFour.pids.filter((pid) => !atOne.pids.includes(pid));
        expect(retired).toHaveLength(3);
        await waitFor(() => retired.every((pid) => !alive(pid)), 3000);

        await methods.get('stop')!({ name: 'web' });
      });

      it('should refuse to scale fork-mode processes or to an invalid size', async () => {
        await methods.get('start')!({ name: 'single', script: clusterScript, killTimeout: 500 });
        await expect(methods.get('scale')!({ name: 'single', instances: 3 })).rejects.toThrow(/fork mode; scaling needs mode: cluster/);
        await methods.get('stop')!({ name: 'single' });

        await methods.get('start')!({ name: 'web', script: clusterScript, mode: 'cluster', instances: 1, killTimeout: 500 });
        await expect(methods.get('scale')!({ name: 'web', instances: 0 })).rejects.toThrow(/positive integer/);
        await expect(methods.get('scale')!({ name: 'nope', instances: 2 })).rejects.toThrow(/not found/);
        await methods.get('stop')!({ name: 'web' });
      });

      it("should resolve instances 'max' to the CPU count", async () => {
        const info = await methods.get('start')!({ name: 'web', script: clusterScript, mode: 'cluster', instances: 'max', killTimeout: 500 }) as { instances: number };
        expect(info.instances).toBe(availableParallelism());
        await methods.get('stop')!({ name: 'web' });
      });
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
        }) as { status: string };
        expect(info.status).toBe('online');

        // Workers report in asynchronously: the cluster primary plus its two workers
        const deadline = Date.now() + 5000;
        let now = await methods.get('info')!({ name: 'cluster' }) as { pids: number[]; runningInstances: number };
        while (now.runningInstances < 2 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
          now = await methods.get('info')!({ name: 'cluster' }) as { pids: number[]; runningInstances: number };
        }
        expect(now.runningInstances).toBe(2);
        expect(now.pids).toHaveLength(3);
        await methods.get('stop')!({ name: 'cluster' });
      });
    });
  });
});
