import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AuditLoggerPlugin, redact, type AuditEntry } from '../../packages/plugins/audit-logger/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

describe('redact', () => {
  it('should mask sensitive keys at any depth and every value inside env', () => {
    const out = redact({
      name: 'api',
      password: 'hunter2',
      nested: { apiKey: 'k', 'X-Auth-Token': 't', ok: 1 },
      env: { DATABASE_URL: 'postgres://u:p@h/db', PORT: '3000', ref: { secret: 'x' } },
      list: [{ secret: 's' }, 'fine'],
    });
    expect(out).toEqual({
      name: 'api',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', 'X-Auth-Token': '[redacted]', ok: 1 },
      env: { DATABASE_URL: '[redacted]', PORT: '[redacted]', ref: '[redacted]' },
      list: [{ secret: '[redacted]' }, 'fine'],
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|postgres|3000/);
  });

  it('should cut long strings, big arrays and deep nesting', () => {
    const out = redact({ big: 'x'.repeat(600), many: Array.from({ length: 80 }, (_, i) => i) }) as { big: string; many: number[] };
    expect(out.big).toHaveLength(501);
    expect(out.many).toHaveLength(50);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });
});

describe('AuditLoggerPlugin', () => {
  let home: string;
  let events: EventBus;
  let audit: AuditLoggerPlugin;
  const methods = new Map<string, (params?: unknown) => Promise<unknown>>();

  const install = (pluginConfig?: Record<string, unknown>) => {
    audit = new AuditLoggerPlugin(home);
    audit.install({
      config: {}, pluginConfig, events, logger: new Logger('audit-test'), store: new StateStore(),
      registerMethod: (name: string, handler: (params?: unknown) => Promise<unknown>) => { methods.set(name, handler); },
      getPlugin: () => undefined,
    } as unknown as PluginContext);
  };
  const entries = () => (audit.tail(100));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'od-audit-'));
    events = new EventBus();
    methods.clear();
    install();
  });

  afterEach(() => {
    audit.onStop();
    rmSync(home, { recursive: true, force: true });
  });

  it('should record an RPC call with target, redacted params, result and duration', () => {
    audit.recordCall({
      method: 'start', connection: 'c1', ok: true, duration: 42,
      params: { name: 'api', script: '/srv/api.js', env: { TOKEN: 'abc' } },
    });
    audit.recordCall({ method: 'stop', connection: 'c1', ok: false, error: 'Process "x" not found', duration: 1, params: { name: 'x' } });

    const [started, failed] = entries() as [AuditEntry, AuditEntry];
    expect(started).toMatchObject({
      action: 'start', result: 'success', duration: 42, target: { type: 'start', name: 'api' },
      actor: { type: 'ipc', connection: 'c1' },
      params: { name: 'api', script: '/srv/api.js', env: { TOKEN: '[redacted]' } },
    });
    expect(new Date(started.timestamp).getTime()).toBeGreaterThan(0);
    expect(failed).toMatchObject({ action: 'stop', result: 'failure', error: 'Process "x" not found' });
    expect(readFileSync(join(home, 'audit.log'), 'utf-8')).not.toContain('abc');
  });

  it('should skip read-only calls unless includeReads is set', () => {
    const read = { method: 'list', connection: 'c', ok: true, duration: 1, params: undefined };
    audit.recordCall(read);
    expect(entries()).toEqual([]);

    audit.onStop();
    install({ includeReads: true });
    audit.recordCall(read);
    expect(entries().map((e) => e.action)).toEqual(['list']);
  });

  it('should record deploy lifecycle events against the app, and treat deploy.status as a read', () => {
    events.emit('deploy:started', { name: 'web', strategy: 'rolling' });
    events.emit('deploy:failed', { name: 'web', strategy: 'rolling', error: 'boom', rolledBack: true });
    audit.recordCall({ method: 'deploy.status', params: { name: 'web' }, ok: true, duration: 1, connection: 'c1' });
    audit.recordCall({ method: 'deploy.execute', params: { name: 'web', release: { env: { TOKEN: 'x' } } }, ok: true, duration: 1, connection: 'c1' });
    expect(entries().map((e) => e.action)).toEqual(['deploy.started', 'deploy.failed', 'deploy.execute']);
    expect(entries()[1]).toMatchObject({ target: { type: 'deploy', name: 'web' } });
    expect(JSON.stringify(entries()[2])).not.toContain('"x"');
  });

  it('should record lifecycle events and WebUI logins, without passwords', () => {
    events.emit('process:started', { name: 'api', pid: 10 });
    events.emit('process:crash', { name: 'api', code: 1, signal: null });
    events.emit('daemon:stopped');
    events.emit('auth:login', { user: 'admin', ok: false, ip: '10.0.0.5' });
    events.emit('auth:login', { user: 'admin', ok: true, ip: '10.0.0.5' });

    expect(entries().map((e) => [e.action, e.result])).toEqual([
      ['process.started', 'success'], ['process.crash', 'success'], ['daemon.stopped', 'success'],
      ['auth.login', 'failure'], ['auth.login', 'success'],
    ]);
    expect(entries()[0]).toMatchObject({ actor: { type: 'daemon' }, target: { type: 'process', name: 'api' } });
    expect(entries()[3]).toMatchObject({ actor: { type: 'webui', user: 'admin' }, params: { ip: '10.0.0.5' } });
  });

  it('should serve the newest entries over the audit RPC and survive a restart', async () => {
    for (let i = 0; i < 5; i++) events.emit('process:started', { name: `p${String(i)}` });
    expect(((await methods.get('audit')!({ lines: 2 })) as AuditEntry[]).map((e) => e.target?.name)).toEqual(['p3', 'p4']);
    expect(await methods.get('audit')!({ lines: 0 })).toEqual([]);

    audit.onStop();
    install();
    events.emit('process:started', { name: 'later' });
    expect(entries().map((e) => e.target?.name)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'later']);
  });

  it('should rotate by size, interval and age from the plugin config', () => {
    audit.onStop();
    install({ maxSize: '1K', maxFiles: 3, compress: false, maxAge: '7d', interval: 'daily' });
    for (let i = 0; i < 30; i++) {
      events.emit('process:started', { name: `p${String(i)}` });
      entries(); // flushes, so each batch is checked against the size limit
    }
    audit.onStop();
    expect(readdirSync(home).filter((f) => /^audit\.log\.\d+$/.test(f)).length).toBeGreaterThan(0);
    expect(readdirSync(home).some((f) => f.endsWith('.gz'))).toBe(false);
  });

  it('should warn about invalid rotation settings and keep the defaults', () => {
    const warnings: string[] = [];
    audit.onStop();
    audit = new AuditLoggerPlugin(home);
    const logger = new Logger('audit-test');
    logger.warn = (m: string) => { warnings.push(m); };
    audit.install({
      config: {}, pluginConfig: { maxSize: 'huge', maxAge: 'soon', interval: 'weekly' }, events, logger,
      store: new StateStore(), registerMethod: () => {}, getPlugin: () => undefined,
    } as unknown as PluginContext);
    expect(warnings).toEqual([
      'Ignoring invalid audit log maxSize "huge"',
      'Ignoring invalid audit log maxAge "soon"',
      'Ignoring invalid audit log interval "weekly"',
    ]);
    events.emit('process:started', { name: 'x' });
    expect(entries()).toHaveLength(1);
  });
});
