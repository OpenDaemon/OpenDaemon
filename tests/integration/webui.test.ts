import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WebuiPlugin } from '../../packages/plugins/webui/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

interface Reply {
  status: number;
  body: string;
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: data }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('WebuiPlugin security', () => {
  let plugin: WebuiPlugin | undefined;
  const startProcess = vi.fn().mockResolvedValue({ name: 'x' });

  async function start(pluginConfig: Record<string, unknown>): Promise<number> {
    // Port 0: the OS picks a free port, so parallel test files never collide
    const context = {
      config: {},
      pluginConfig: { port: 0, ...pluginConfig },
      events: new EventBus(),
      logger: new Logger('webui-test'),
      store: new StateStore(),
      registerMethod: () => {},
      registerHook: () => {},
      getPlugin: (name: string) => (name === 'metrics-collector'
        ? { prometheus: () => 'od_system_cpu_percent 1\n', collect: () => ({ processes: [] }) }
        : { getProcesses: () => [], startProcessFromPlugin: startProcess }),
      registerMetric: () => {},
    } as unknown as PluginContext;

    plugin = new WebuiPlugin();
    plugin.install(context);
    await plugin.onStart(context);
    return (plugin as unknown as { server: { address(): { port: number } } }).server.address().port;
  }

  afterEach(async () => {
    await plugin?.onStop();
    plugin = undefined;
    startProcess.mockClear();
  });

  it('should listen on loopback only by default', async () => {
    const port = await start({});
    const address = (plugin as unknown as { server: { address(): { address: string } } }).server.address();
    expect(address.address).toBe('127.0.0.1');
    expect((await send(port, 'GET', '/api/processes')).status).toBe(200);
  });

  it('should reject a foreign Host header (DNS rebinding)', async () => {
    const port = await start({});
    const reply = await send(port, 'GET', '/api/processes', { Host: `evil.example:${String(port)}` });
    expect(reply.status).toBe(403);
  });

  it('should reject a cross-site simple POST without starting anything (CSRF)', async () => {
    const port = await start({});
    const reply = await send(
      port, 'POST', '/api/start',
      { 'Content-Type': 'text/plain', Origin: 'http://evil.example' },
      JSON.stringify({ name: 'x', script: '/tmp/x.js' })
    );
    expect(reply.status).toBe(403);
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('should accept a same-origin POST from the dashboard', async () => {
    const port = await start({});
    const reply = await send(
      port, 'POST', '/api/start',
      { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${String(port)}` },
      JSON.stringify({ name: 'x', script: '/tmp/x.js' })
    );
    expect(reply.status).toBe(200);
    expect(startProcess).toHaveBeenCalledOnce();
  });

  it('should not send permissive CORS headers', async () => {
    const port = await start({});
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/processes' }, (res) => {
        res.resume();
        resolve(res.headers);
      }).on('error', reject).end();
    });
    expect(reply['access-control-allow-origin']).toBeUndefined();
  });

  it('should issue an unguessable token and accept Basic auth passwords containing ":"', async () => {
    const port = await start({ username: 'admin', password: 'pa:ss' });

    const login = await send(
      port, 'POST', '/api/login', { 'Content-Type': 'application/json' },
      JSON.stringify({ username: 'admin', password: 'pa:ss' })
    );
    const { token } = JSON.parse(login.body) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    expect((await send(port, 'GET', '/api/processes', { Authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await send(port, 'GET', '/api/processes', { Authorization: 'Bearer wrong' })).status).toBe(401);

    const basic = Buffer.from('admin:pa:ss').toString('base64');
    expect((await send(port, 'GET', '/api/processes', { Authorization: `Basic ${basic}` })).status).toBe(200);
  });

  it('should serve Prometheus text at /metrics and JSON at /api/metrics', async () => {
    const port = await start({});
    const text = await new Promise<{ type: string | undefined; body: string }>((resolveReply, reject) => {
      request({ host: '127.0.0.1', port, path: '/metrics' }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => { resolveReply({ type: res.headers['content-type'], body }); });
      }).on('error', reject).end();
    });
    expect(text).toEqual({ type: 'text/plain; version=0.0.4; charset=utf-8', body: 'od_system_cpu_percent 1\n' });
    expect(JSON.parse((await send(port, 'GET', '/api/metrics')).body)).toEqual({ processes: [] });
  });

  it('should ask scrapers for Basic auth on /metrics when auth is enabled', async () => {
    const port = await start({ username: 'prom', password: 'scrape' });
    const denied = await new Promise<{ status: number; challenge: string | undefined }>((resolveReply, reject) => {
      request({ host: '127.0.0.1', port, path: '/metrics' }, (res) => {
        res.resume();
        resolveReply({ status: res.statusCode ?? 0, challenge: res.headers['www-authenticate'] });
      }).on('error', reject).end();
    });
    expect(denied).toEqual({ status: 401, challenge: 'Basic realm="OpenDaemon"' });

    const basic = Buffer.from('prom:scrape').toString('base64');
    expect((await send(port, 'GET', '/metrics', { Authorization: `Basic ${basic}` })).body).toContain('od_system_cpu_percent');
  });

  it('should issue one token per login and revoke only the session that logs out', async () => {
    const port = await start({ username: 'admin', password: 'pw' });
    const login = async () => (JSON.parse((await send(
      port, 'POST', '/api/login', { 'Content-Type': 'application/json' },
      JSON.stringify({ username: 'admin', password: 'pw' })
    )).body) as { token: string }).token;
    const status = async (token: string) =>
      (await send(port, 'GET', '/api/processes', { Authorization: `Bearer ${token}` })).status;

    const laptop = await login();
    const phone = await login();
    expect(laptop).not.toBe(phone);

    expect((await send(port, 'POST', '/api/logout', { Authorization: `Bearer ${laptop}` })).status).toBe(200);
    expect(await status(laptop)).toBe(401);
    expect(await status(phone)).toBe(200);

    // Logging out requires a valid session
    expect((await send(port, 'POST', '/api/logout')).status).toBe(401);
  });

  it('should expire sessions after sessionTtl', async () => {
    const port = await start({ username: 'admin', password: 'pw', sessionTtl: 100 });
    const { token } = JSON.parse((await send(
      port, 'POST', '/api/login', { 'Content-Type': 'application/json' },
      JSON.stringify({ username: 'admin', password: 'pw' })
    )).body) as { token: string };

    expect((await send(port, 'GET', '/api/processes', { Authorization: `Bearer ${token}` })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect((await send(port, 'GET', '/api/processes', { Authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe('WebuiPlugin when its port is taken', () => {
  it('should log the problem and let the daemon start without the dashboard', async () => {
    const { createServer } = await import('http');
    const blocker = createServer();
    await new Promise<void>((resolveListen) => { blocker.listen(0, '127.0.0.1', resolveListen); });
    const port = (blocker.address() as { port: number }).port;
    try {
      const plugin = new WebuiPlugin();
      const errors: string[] = [];
      const context = {
        config: {}, pluginConfig: { port },
        events: new EventBus(), store: new StateStore(),
        logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: (m: string) => { errors.push(m); } },
        registerMethod: () => undefined, getPlugin: () => undefined,
      } as unknown as PluginContext;
      plugin.install(context);
      await expect(plugin.onStart(context)).resolves.toBeUndefined();
      expect(errors.join('\n')).toContain('WebUI disabled');
      await expect(plugin.onStop()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolveClose) => { blocker.close(() => { resolveClose(); }); });
    }
  });
});

describe('WebuiPlugin generated credentials', () => {
  let plugin: WebuiPlugin | undefined;
  let home: string;
  const startProcess = vi.fn().mockResolvedValue({ name: 'x' });

  async function start(pluginConfig: Record<string, unknown> = {}, withHome = true): Promise<number> {
    const logs: string[] = [];
    const context = {
      config: {}, pluginConfig: { port: 0, ...pluginConfig }, events: new EventBus(), store: new StateStore(),
      logger: { info: (m: string) => { logs.push(m); }, warn: (m: string) => { logs.push(m); }, error: () => undefined, debug: () => undefined },
      registerMethod: () => undefined, getPlugin: () => ({ getProcesses: () => [], startProcessFromPlugin: startProcess }),
    } as unknown as PluginContext;
    plugin = new WebuiPlugin(withHome ? home : undefined);
    plugin.install(context);
    await plugin.onStart(context);
    lastLogs = logs;
    return (plugin as unknown as { server: { address(): { port: number } } }).server.address().port;
  }
  let lastLogs: string[] = [];
  const credentials = () => {
    const text = readFileSync(join(home, 'webui-credentials'), 'utf-8');
    return { username: /^username: (.+)$/m.exec(text)?.[1] ?? '', password: /^password: (.+)$/m.exec(text)?.[1] ?? '' };
  };
  const basic = ({ username, password }: { username: string; password: string }) =>
    ({ Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` });
  const startBody = JSON.stringify({ name: 'x', script: '/bin/sh', interpreter: 'none' });

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'od-webui-')); });
  afterEach(async () => {
    await plugin?.onStop();
    plugin = undefined;
    startProcess.mockClear();
    rmSync(home, { recursive: true, force: true });
  });

  it('should refuse anonymous requests, so another local user cannot start programs', async () => {
    const port = await start();
    expect((await send(port, 'GET', '/api/processes')).status).toBe(401);
    expect((await send(port, 'POST', '/api/start', { 'Content-Type': 'application/json' }, startBody)).status).toBe(401);
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('should accept the generated credentials, and keep them private to the daemon user', async () => {
    const port = await start();
    expect((await send(port, 'GET', '/api/processes', basic(credentials()))).status).toBe(200);
    expect((await send(port, 'GET', '/api/processes', basic({ username: 'admin', password: 'wrong' }))).status).toBe(401);
    if (process.platform !== 'win32') expect(statSync(join(home, 'webui-credentials')).mode & 0o777).toBe(0o600);
    expect(lastLogs.join('\n')).toContain('webui-credentials');
    expect(lastLogs.join('\n')).not.toContain(credentials().password);
  });

  it('should keep the same login after a restart', async () => {
    await start();
    const first = credentials();
    await plugin?.onStop();
    const port = await start();
    expect(credentials()).toEqual(first);
    expect((await send(port, 'GET', '/api/processes', basic(first))).status).toBe(200);
  });

  it('should prefer credentials from the config over generated ones', async () => {
    const port = await start({ username: 'ops', password: 'configured-secret' });
    expect((await send(port, 'GET', '/api/processes', basic({ username: 'ops', password: 'configured-secret' }))).status).toBe(200);
    expect(existsSync(join(home, 'webui-credentials'))).toBe(false);
  });

  it('should allow switching authentication off explicitly, with a warning', async () => {
    const port = await start({ auth: false });
    expect((await send(port, 'GET', '/api/processes')).status).toBe(200);
    expect(lastLogs.join('\n')).toContain('authentication is off');
  });

  it('should regenerate credentials that are too short to be safe', async () => {
    writeFileSync(join(home, 'webui-credentials'), 'username: admin\npassword: abc\n');
    await start();
    expect(credentials().password.length).toBeGreaterThanOrEqual(16);
  });
});
