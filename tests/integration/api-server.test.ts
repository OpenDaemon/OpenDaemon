import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request, type IncomingMessage } from 'http';
import { randomBytes } from 'crypto';
import type { Duplex } from 'stream';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ApiServerPlugin, type ApiServerConfig } from '../../packages/plugins/api-server/src/index.js';
import { acceptKey, encodeFrame } from '../../packages/plugins/api-server/src/websocket.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

const TOKEN = 'test-token-0123456789';

describe('ApiServerPlugin', () => {
  let home: string;
  let plugin: ApiServerPlugin;
  let events: EventBus;
  const calls: Array<{ method: string; params: unknown }> = [];
  let answers: Record<string, unknown>;

  const rpc = (method: string, params?: unknown): Promise<unknown> => {
    calls.push({ method, params });
    const answer = answers[method];
    if (answer === undefined) return Promise.reject(new Error(`Method not found: ${method}`));
    try {
      return Promise.resolve(typeof answer === 'function' ? answer(params) : answer);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  async function boot(given: ApiServerConfig | 'absent' = { port: 0, token: TOKEN, metricsInterval: 50 }): Promise<void> {
    const config = given === 'absent' ? undefined : given;
    plugin = new ApiServerPlugin(home, rpc);
    const context = {
      config: {}, pluginConfig: config, events, logger: new Logger('api-test'), store: new StateStore(),
      registerMethod: () => {}, getPlugin: () => undefined,
    } as unknown as PluginContext;
    plugin.install(context);
    await plugin.onStart(context);
  }

  interface Reply { status: number; headers: IncomingMessage['headers']; body: string; json: () => any }
  const http = (method: string, path: string, options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const token = options.token === undefined ? TOKEN : options.token;
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const req = request({
        host: '127.0.0.1', port: plugin.port, method, path,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }); });
      });
      req.on('error', reject);
      req.end(payload);
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'od-api-'));
    events = new EventBus();
    calls.length = 0;
    answers = {};
  });
  afterEach(async () => {
    await plugin.onStop();
    rmSync(home, { recursive: true, force: true });
  });

  describe('REST', () => {
    beforeEach(async () => { await boot(); });

    it('should answer the health check without a token but nothing else', async () => {
      expect((await http('GET', '/api/v1/health', { token: null })).json()).toEqual({ status: 'ok' });
      expect((await http('GET', '/api/v1/processes', { token: null })).status).toBe(401);
      expect((await http('GET', '/api/v1/processes', { token: 'wrong-token-0123456789' })).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it('should list, inspect, start, stop, restart, reload, scale and delete', async () => {
      answers = { list: [{ name: 'api' }], info: (p: unknown) => ((p as { name: string }).name === 'api' ? { name: 'api' } : null), start: { name: 'new' }, stop: null, restart: { name: 'api' }, scale: { instances: 3 }, delete: null };
      expect((await http('GET', '/api/v1/processes')).json()).toEqual([{ name: 'api' }]);
      expect((await http('GET', '/api/v1/processes/api')).json()).toEqual({ name: 'api' });
      expect((await http('GET', '/api/v1/processes/ghost')).status).toBe(404);
      expect((await http('POST', '/api/v1/processes', { body: { name: 'new', script: 'x.js' } })).json()).toEqual({ name: 'new' });
      expect((await http('PUT', '/api/v1/processes/api/stop')).json()).toEqual({ ok: true });
      await http('PUT', '/api/v1/processes/api/restart');
      await http('PUT', '/api/v1/processes/api/reload');
      expect((await http('PUT', '/api/v1/processes/api/scale', { body: { instances: 3 } })).json()).toEqual({ instances: 3 });
      await http('DELETE', '/api/v1/processes/api');
      expect(calls.map((c) => c.method)).toEqual(['list', 'info', 'info', 'start', 'stop', 'restart', 'restart', 'scale', 'delete']);
      expect(calls[3]?.params).toEqual({ name: 'new', script: 'x.js' });
      expect(calls[7]?.params).toEqual({ name: 'api', instances: 3 });
    });

    it('should start, follow and roll back deploys', async () => {
      answers = { 'deploy.execute': { state: 'running' }, 'deploy.status': { state: 'succeeded' }, 'deploy.rollback': { state: 'running' } };
      expect((await http('POST', '/api/v1/processes/web/deploy', { body: { strategy: 'canary', release: { script: 'v2.js' } } })).json()).toEqual({ state: 'running' });
      expect((await http('GET', '/api/v1/processes/web/deploy')).json()).toEqual({ state: 'succeeded' });
      await http('PUT', '/api/v1/processes/web/rollback');
      expect(calls.map((c) => c.method)).toEqual(['deploy.execute', 'deploy.status', 'deploy.rollback']);
      expect(calls[0]?.params).toEqual({ name: 'web', strategy: 'canary', release: { script: 'v2.js' } });
      answers = { 'deploy.execute': () => { throw new Error('A deploy of "web" is already running'); } };
      expect((await http('POST', '/api/v1/processes/web/deploy', { body: {} })).status).toBe(409);
    });

    it('should decode names and pass log filters', async () => {
      answers = { 'logs.query': [] };
      await http('GET', '/api/v1/processes/my%20app/logs?lines=5&grep=err&since=10&source=stderr');
      expect(calls[0]).toEqual({ method: 'logs.query', params: { name: 'my app', lines: 5, since: 10, grep: 'err', source: 'stderr' } });
    });

    it('should serve Prometheus text, per-process metrics and daemon routes', async () => {
      answers = {
        metrics: (p: unknown) => ((p as { format: string }).format === 'prometheus' ? '# HELP x\nx 1\n' : { processes: [{ name: 'api', cpu: 1 }] }),
        'daemon.status': { pid: 1 }, reload: { ok: true },
      };
      const prom = await http('GET', '/api/v1/metrics');
      expect(prom.headers['content-type']).toContain('text/plain');
      expect(prom.body).toBe('# HELP x\nx 1\n');
      expect((await http('GET', '/api/v1/processes/api/metrics')).json()).toEqual({ name: 'api', cpu: 1 });
      expect((await http('GET', '/api/v1/processes/ghost/metrics')).status).toBe(404);
      expect((await http('GET', '/api/v1/daemon/status')).json()).toEqual({ pid: 1 });
      expect((await http('POST', '/api/v1/daemon/reload')).json()).toEqual({ ok: true });
    });

    it('should map errors to 404, 400 and 502 and reject bad routes', async () => {
      answers = { start: () => { throw new Error('script is required'); }, stop: () => { throw new Error('Not connected to server'); } };
      expect((await http('POST', '/api/v1/processes', { body: {} })).json()).toEqual({ error: 'script is required' });
      expect((await http('POST', '/api/v1/processes', { body: {} })).status).toBe(400);
      expect((await http('PUT', '/api/v1/processes/a/stop')).status).toBe(502);
      expect((await http('PUT', '/api/v1/processes/a/restart')).status).toBe(404); // rpc: method not found
      expect((await http('GET', '/api/v1/nope')).status).toBe(404);
      expect((await http('PUT', '/api/v1/processes')).status).toBe(405);
      expect((await http('GET', '/other')).status).toBe(404);
    });

    it('should reject a body that is not a JSON object or is too large', async () => {
      expect((await http('POST', '/api/v1/processes', { body: [1] })).status).toBe(400);
      await plugin.onStop();
      await boot({ port: 0, token: TOKEN, maxBodySize: 20 });
      expect((await http('POST', '/api/v1/processes', { body: { script: 'x'.repeat(50) } })).status).toBe(413);
    });

    it('should refuse foreign Hosts and Origins, and allow listed origins with CORS headers', async () => {
      answers = { list: [] };
      expect((await http('GET', '/api/v1/processes', { headers: { Host: 'evil.example' } })).status).toBe(403);
      expect((await http('GET', '/api/v1/processes', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
      await plugin.onStop();
      await boot({ port: 0, token: TOKEN, cors: ['https://ok.example'] });
      const ok = await http('GET', '/api/v1/processes', { headers: { Origin: 'https://ok.example' } });
      expect(ok.status).toBe(200);
      expect(ok.headers['access-control-allow-origin']).toBe('https://ok.example');
      const preflight = await http('OPTIONS', '/api/v1/processes', { token: null, headers: { Origin: 'https://ok.example' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('should rate limit per client', async () => {
      await plugin.onStop();
      await boot({ port: 0, token: TOKEN, rateLimit: 3 });
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await http('GET', '/api/v1/health')).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    });
  });

  describe('startup', () => {
    it('should stay off without configuration, or when disabled', async () => {
      await boot('absent');
      expect(plugin.port).toBe(9615);
      await plugin.onStop();
      await boot({ enabled: false } as ApiServerConfig);
      await expect(http('GET', '/api/v1/health')).rejects.toThrow();
    });

    it('should generate a private token file when none is configured', async () => {
      await boot({ port: 0 });
      const file = join(home, 'api-token');
      expect(readFileSync(file, 'utf-8')).toBe(plugin.bearerToken);
      expect(plugin.bearerToken).toHaveLength(48);
      expect(statSync(file).mode & 0o777).toBe(process.platform === 'win32' ? statSync(file).mode & 0o777 : 0o600);
    });

    it('should refuse a short token', async () => {
      await expect(boot({ port: 0, token: 'short' })).rejects.toThrow('at least 16 characters');
    });
  });

  describe('WebSocket', () => {
    interface Socket { send: (value: unknown) => void; next: () => Promise<any>; end: () => void; raw: Duplex }

    /** Minimal client: handshake, masked text frames out, unmasked frames in */
    function connect(options: { path?: string; token?: string | null; headers?: Record<string, string> } = {}): Promise<Socket | { status: number }> {
      return new Promise((resolve, reject) => {
        const key = randomBytes(16).toString('base64');
        const token = options.token === undefined ? TOKEN : options.token;
        const req = request({
          host: '127.0.0.1', port: plugin.port, path: options.path ?? '/ws',
          headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
        });
        req.on('response', (res) => { resolve({ status: res.statusCode ?? 0 }); res.resume(); });
        req.on('upgrade', (res, socket) => {
          expect(res.headers['sec-websocket-accept']).toBe(acceptKey(key));
          const queue: any[] = [];
          const waiting: Array<(m: any) => void> = [];
          let buffer = Buffer.alloc(0);
          socket.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
              if (buffer.length < 2) return;
              let length = (buffer[1] as number) & 0x7f;
              let offset = 2;
              if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
              if (buffer.length < offset + length) return;
              const opcode = (buffer[0] as number) & 0x0f;
              const payload = buffer.subarray(offset, offset + length);
              buffer = buffer.subarray(offset + length);
              if (opcode !== 1) continue;
              const message = JSON.parse(payload.toString());
              const waiter = waiting.shift();
              if (waiter) waiter(message); else queue.push(message);
            }
          });
          resolve({
            raw: socket,
            send: (value) => {
              const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
              const mask = randomBytes(4);
              const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number)));
              const frame = encodeFrame(0x1, payload);
              // re-encode with the mask bit and key (encodeFrame builds unmasked server frames)
              const head = Buffer.from(frame.subarray(0, frame.length - payload.length));
              head[1] = (head[1] as number) | 0x80;
              socket.write(Buffer.concat([head, mask, masked]));
            },
            next: () => new Promise((done, fail) => {
              const queued = queue.shift();
              if (queued !== undefined) { done(queued); return; }
              const timer = setTimeout(() => { fail(new Error('no message')); }, 2000);
              waiting.push((m) => { clearTimeout(timer); done(m); });
            }),
            end: () => { socket.destroy(); },
          });
        });
        req.on('error', reject);
        req.end();
      });
    }
    const open = async (options = {}): Promise<Socket> => {
      const result = await connect(options);
      if (!('send' in result)) throw new Error(`refused with ${String(result.status)}`);
      return result;
    };

    beforeEach(async () => { await boot(); });

    it('should refuse unauthenticated, foreign-origin and wrong-path upgrades', async () => {
      expect(await connect({ token: null })).toEqual({ status: 401 });
      expect(await connect({ headers: { Origin: 'https://evil.example' } })).toEqual({ status: 403 });
      expect(await connect({ path: '/nope' })).toEqual({ status: 404 });
      expect(await connect({ headers: { Host: 'evil.example' } })).toEqual({ status: 403 });
    });

    it('should accept the token as a query parameter (browsers cannot set headers)', async () => {
      const ws = await open({ path: `/ws?token=${TOKEN}`, token: null });
      ws.send({ subscribe: ['daemon:*'] });
      expect((await ws.next()).event).toBe('subscribed');
      ws.end();
    });

    it('should stream subscribed events only, with secrets redacted', async () => {
      const ws = await open();
      ws.send({ subscribe: ['process:*', 'log:api'] });
      expect(await ws.next()).toEqual({ event: 'subscribed', data: { patterns: ['process:*', 'log:api'] } });

      events.emit('config:reloaded', {});                       // not subscribed
      events.emit('process:started', { name: 'api', env: { DB: 'secret-value' }, password: 'p' });
      events.emit('process:log', { processName: 'api', message: 'hello' });
      events.emit('process:log', { processName: 'other', message: 'no' });

      const started = await ws.next();
      expect(started).toEqual({ event: 'process:started', data: { name: 'api', env: { DB: '[redacted]' }, password: '[redacted]' } });
      expect(await ws.next()).toEqual({ event: 'log:api', data: { processName: 'api', message: 'hello' } });
      ws.send({ unsubscribe: ['log:api'] });
      expect((await ws.next()).data.patterns).toEqual(['process:*']);
      ws.end();
    });

    it('should push metric snapshots to subscribers', async () => {
      answers = { metrics: { timestamp: 't', processes: [] } };
      const ws = await open();
      ws.send({ subscribe: ['metric:*'] });
      await ws.next();
      expect(await ws.next()).toEqual({ event: 'metric:snapshot', data: { timestamp: 't', processes: [] } });
      ws.end();
    });

    it('should report invalid messages and subscriptions', async () => {
      const ws = await open();
      ws.send('not json');
      expect((await ws.next()).event).toBe('error');
      ws.send({ subscribe: [''] });
      expect((await ws.next()).event).toBe('error');
      ws.send({ subscribe: Array.from({ length: 101 }, (_, i) => `e${String(i)}`) });
      expect((await ws.next()).event).toBe('error');
      ws.end();
    });

    it('should close on unmasked client frames and limit connections', async () => {
      const ws = await open();
      const closed = new Promise<void>((resolve) => { ws.raw.on('close', () => { resolve(); }); });
      ws.raw.write(encodeFrame(0x1, Buffer.from('{}')));          // client frames must be masked
      await closed;

      await plugin.onStop();
      await boot({ port: 0, token: TOKEN, maxConnections: 1 });
      const first = await open();
      expect(await connect()).toEqual({ status: 503 });
      first.end();
    });
  });
});
