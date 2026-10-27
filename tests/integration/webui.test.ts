import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from 'http';
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
    const port = 20000 + Math.floor(Math.random() * 20000);
    const context = {
      config: {},
      pluginConfig: { port, ...pluginConfig },
      events: new EventBus(),
      logger: new Logger('webui-test'),
      store: new StateStore(),
      registerMethod: () => {},
      registerHook: () => {},
      getPlugin: () => ({ getProcesses: () => [], startProcessFromPlugin: startProcess }),
      registerMetric: () => {},
    } as unknown as PluginContext;

    plugin = new WebuiPlugin();
    await plugin.install(context);
    await plugin.onStart(context);
    return port;
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
});
