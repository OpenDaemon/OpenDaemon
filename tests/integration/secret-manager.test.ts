import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src/index.js';
import { SecretManagerPlugin, SecretStore, referencedSecrets } from '../../packages/plugins/secret-manager/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext, ProcessConfig, ProcessInfo } from '../../packages/core/src/index.js';

type Method = (params?: unknown) => Promise<unknown>;

describe('SecretManagerPlugin with the process manager', () => {
  let dir: string;
  let store: SecretStore;
  let pm: ProcessManagerPlugin;
  const methods = new Map<string, Method>();
  const output: Array<{ processName: string; message: string }> = [];

  /** Prints the given env vars once, then idles */
  const printer = (...names: string[]): string => {
    const path = join(dir, 'print.cjs');
    writeFileSync(path, `console.log(JSON.stringify({ ${names.map((n) => `${n}: process.env.${n}`).join(', ')} })); setInterval(() => {}, 1000);`);
    return path;
  };
  const start = (config: Partial<ProcessConfig> & { name: string }) =>
    methods.get('start')!({ script: printer('DATABASE_URL', 'PORT'), killTimeout: 300, ...config });
  const printed = async (name: string): Promise<Record<string, string>> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const lines = output.filter((o) => o.processName === name);
      const last = lines.at(-1);
      if (last) return JSON.parse(last.message) as Record<string, string>;
      if (Date.now() > deadline) throw new Error(`no output from ${name}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-secret-pm-'));
    store = new SecretStore(dir, undefined);
    output.length = 0;
    methods.clear();
    const events = new EventBus();
    events.on('process:log', (d: unknown) => { output.push(d as (typeof output)[number]); });
    pm = new ProcessManagerPlugin();
    const secrets = new SecretManagerPlugin(dir);
    const context = {
      config: {},
      events,
      logger: new Logger('secret-test'),
      store: new StateStore(),
      registerMethod: (name: string, handler: Method) => { methods.set(name, handler); },
      getPlugin: (name: string) => ({ 'process-manager': pm, 'secret-manager': secrets } as Record<string, unknown>)[name],
    } as unknown as PluginContext;
    pm.install(context);
    secrets.install(context);
  });

  afterEach(async () => {
    await pm.onStop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should inject the decrypted secret and stringify numeric values', async () => {
    store.set('DATABASE_URL', 'postgres://u:p@h/db');
    await start({ name: 'api', env: { DATABASE_URL: { secret: 'DATABASE_URL' }, PORT: 3000 as unknown as string } });
    expect(await printed('api')).toEqual({ DATABASE_URL: 'postgres://u:p@h/db', PORT: '3000' });
  });

  it('should inject a pinned version', async () => {
    store.set('DATABASE_URL', 'v1');
    store.set('DATABASE_URL', 'v2');
    await start({ name: 'api', env: { DATABASE_URL: { secret: 'DATABASE_URL', version: 1 } } });
    expect((await printed('api'))['DATABASE_URL']).toBe('v1');
  });

  it('should fail the start naming the missing secret, without leaking anything', async () => {
    await expect(start({ name: 'api', env: { DATABASE_URL: { secret: 'NOPE' } } }))
      .rejects.toThrow('env.DATABASE_URL: Secret "NOPE" is not set (od secret set NOPE ...)');
  });

  it('should restart only the processes that use a rotated secret', async () => {
    store.set('DATABASE_URL', 'old');
    await start({ name: 'api', env: { DATABASE_URL: { secret: 'DATABASE_URL' } } });
    await start({ name: 'other', env: { PORT: '1' } });
    expect((await printed('api'))['DATABASE_URL']).toBe('old');
    const otherPid = (await methods.get('info')!({ name: 'other' }) as ProcessInfo).pid;

    store.set('DATABASE_URL', 'new');
    output.length = 0;
    expect(await methods.get('secrets.rotated')!({ name: 'DATABASE_URL' })).toEqual(['api']);
    expect((await printed('api'))['DATABASE_URL']).toBe('new');
    expect((await methods.get('info')!({ name: 'other' }) as ProcessInfo).pid).toBe(otherPid);
  });

  it('should list the secrets a config references', () => {
    expect(referencedSecrets({ name: 'x', script: 'x', env: { A: { secret: 'S1' }, B: 'plain', C: { secret: 'S2' } } }))
      .toEqual(['S1', 'S2']);
  });
});
