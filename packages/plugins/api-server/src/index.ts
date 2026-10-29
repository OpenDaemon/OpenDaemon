import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Duplex } from 'stream';
import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { redact } from '../../audit-logger/src/index.js';
import { WebSocketConnection, acceptKey } from './websocket.js';

export interface ApiServerConfig {
  /** Default 9615 (0 lets the OS pick) */
  port?: number;
  /** Default 127.0.0.1. The API can start arbitrary scripts: only widen this with a token and TLS */
  host?: string;
  /** Bearer token (at least 16 characters). Generated at each start and written to <home>/api-token when omitted */
  token?: string;
  /** Browser origins allowed to call the API (CORS) and to open WebSockets. Default: none */
  cors?: string[];
  /** Requests per minute and client address (default 600; 0 disables) */
  rateLimit?: number;
  /** Largest accepted request body in bytes (default 1 MiB) */
  maxBodySize?: number;
  /** Paths of a PEM certificate and key: serve HTTPS/WSS */
  tls?: { cert: string; key: string };
  /** How often `metric:snapshot` is pushed to subscribed WebSocket clients, in ms (default 5000) */
  metricsInterval?: number;
  /** Concurrent WebSocket connections (default 100) */
  maxConnections?: number;
}

/** Calls an RPC method of this daemon */
export type Rpc = (method: string, params?: unknown) => Promise<unknown>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** "process:*" -> matcher (the same wildcard rule as the event bus) */
function matcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOST_HEADERS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const MAX_PATTERNS = 100;

interface Client {
  ws: WebSocketConnection;
  patterns: Map<string, RegExp>;
}

/**
 * API Server Plugin (opt-in: configure `plugins.api-server`)
 * REST API under /api/v1 and an event stream at /ws, built on node:http only. Every route
 * forwards to the daemon's own RPC methods, so behaviour, validation and the audit log are
 * the same as for the CLI.
 */
export class ApiServerPlugin implements Plugin {
  name = 'api-server';
  version = '1.0.0';
  description = 'REST API and WebSocket event stream';
  priority = 21;

  private context!: PluginContext;
  private server: Server | undefined;
  private config: Required<Pick<ApiServerConfig, 'port' | 'host' | 'rateLimit' | 'maxBodySize' | 'metricsInterval' | 'maxConnections'>> & { cors: string[] } =
    { port: 9615, host: '127.0.0.1', rateLimit: 600, maxBodySize: 1024 * 1024, metricsInterval: 5000, maxConnections: 100, cors: [] };
  private token = '';
  private unsubscribe: (() => void) | undefined;
  private metricsTimer: NodeJS.Timeout | undefined;
  private readonly clients = new Set<Client>();
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(private readonly home: string, private readonly rpc: Rpc) {}

  install(context: PluginContext): void {
    this.context = context;
  }

  /** The port actually bound (useful with `port: 0`) */
  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.config.port;
  }

  get bearerToken(): string {
    return this.token;
  }

  async onStart(context: PluginContext): Promise<void> {
    this.context = context;
    const configured = context.pluginConfig as ApiServerConfig | undefined;
    if (configured === undefined || (configured as { enabled?: boolean }).enabled === false) return;

    this.config = {
      port: configured.port ?? 9615,
      host: configured.host ?? '127.0.0.1',
      rateLimit: configured.rateLimit ?? 600,
      maxBodySize: configured.maxBodySize ?? 1024 * 1024,
      metricsInterval: configured.metricsInterval ?? 5000,
      maxConnections: configured.maxConnections ?? 100,
      cors: configured.cors ?? [],
    };
    if (configured.token !== undefined && configured.token.length < 16) {
      throw new Error('api-server: token must be at least 16 characters');
    }
    this.token = configured.token ?? randomBytes(24).toString('hex');
    if (configured.token === undefined) {
      writeFileSync(resolve(this.home, 'api-token'), this.token, { mode: 0o600 });
    }

    const handler = (req: IncomingMessage, res: ServerResponse): void => { void this.handle(req, res); };
    this.server = configured.tls
      ? createHttpsServer({ cert: readFileSync(configured.tls.cert), key: readFileSync(configured.tls.key) }, handler)
      : createHttpServer(handler);
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex) => { this.upgrade(req, socket); });

    await new Promise<void>((ok, fail) => {
      this.server?.once('error', fail);
      this.server?.listen(this.config.port, this.config.host, ok);
    });
    this.context.logger.info(`API server listening on ${configured.tls ? 'https' : 'http'}://${this.config.host}:${String(this.port)}`);

    this.unsubscribe = this.subscribeEvents();
    this.metricsTimer = setInterval(() => { void this.pushMetrics(); }, this.config.metricsInterval);
    this.metricsTimer.unref();
  }

  async onStop(): Promise<void> {
    this.unsubscribe?.();
    clearInterval(this.metricsTimer);
    for (const client of this.clients) client.ws.close(1001);
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => { server.close(() => { done(); }); });
    }
  }

  // --- shared checks ---

  private hostAllowed(req: IncomingMessage): boolean {
    // A loopback API must not answer pages that reached it through DNS rebinding
    if (!LOOPBACK_HOSTS.has(this.config.host)) return true;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    return LOOPBACK_HOST_HEADERS.has(host);
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return origin === undefined || this.config.cors.includes(origin);
  }

  private authorized(req: IncomingMessage, allowQuery = false): boolean {
    const header = req.headers.authorization;
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token === undefined && allowQuery) {
      token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
    }
    return token !== undefined && safeEqual(token, this.token);
  }

  private limited(req: IncomingMessage): boolean {
    if (this.config.rateLimit <= 0) return false;
    const now = Date.now();
    const key = req.socket.remoteAddress ?? '';
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      // Expired entries are dropped as new windows open, so the map cannot grow without bound
      if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      entry = { count: 0, reset: now + 60000 };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > this.config.rateLimit;
  }

  // --- REST ---

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(text);
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > this.config.maxBodySize) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Body must be a JSON object');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.hostAllowed(req)) throw new HttpError(403, 'Forbidden host');
      if (!this.originAllowed(req)) throw new HttpError(403, 'Origin not allowed');
      const origin = req.headers.origin;
      const cors: Record<string, string> = origin
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
        : {};

      if (req.method === 'OPTIONS') {
        this.send(res, 204, '', {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        });
        return;
      }
      if (this.limited(req)) throw new HttpError(429, 'Too many requests');

      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && path === '/api/v1/health') {
        this.send(res, 200, { status: 'ok' }, cors);
        return;
      }
      if (!path.startsWith('/api/v1/')) throw new HttpError(404, 'Not found');
      if (!this.authorized(req)) throw new HttpError(401, 'Unauthorized');

      const result = await this.route(req.method ?? 'GET', path.slice('/api/v1'.length).split('/').filter(Boolean).map(decodeURIComponent), url, req);
      if (typeof result === 'string') this.send(res, 200, result, cors);
      else this.send(res, 200, result ?? { ok: true }, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : this.rpcStatus(err as Error);
      const message = (err as Error).message;
      this.send(res, status, { error: message });
    }
  }

  /** RPC errors are mostly the caller's doing; only a lost connection is the server's */
  private rpcStatus(err: Error): number {
    if (/not found/i.test(err.message)) return 404;
    if (/already running/i.test(err.message)) return 409;
    if (/not connected|ECONN|ENOENT|timeout/i.test(err.message)) return 502;
    return 400;
  }

  private async route(method: string, parts: string[], url: URL, req: IncomingMessage): Promise<unknown> {
    const [root, name, action] = parts;
    const query = url.searchParams;
    const wrong = new HttpError(404, 'Not found');
    const notAllowed = new HttpError(405, 'Method not allowed');

    if (root === 'processes') {
      if (name === undefined) {
        if (method === 'GET') return this.rpc('list');
        if (method === 'POST') return this.rpc('start', await this.readJson(req));
        throw notAllowed;
      }
      if (action === undefined) {
        if (method === 'GET') {
          const info = await this.rpc('info', { name });
          if (info === null || info === undefined) throw new HttpError(404, `Process "${name}" not found`);
          return info;
        }
        if (method === 'DELETE') return this.rpc('delete', { name });
        throw notAllowed;
      }
      if (parts.length > 3) throw wrong;
      if (action === 'logs' && method === 'GET') {
        const lines = query.get('lines');
        const since = query.get('since');
        return this.rpc('logs.query', {
          name,
          ...(lines === null ? {} : { lines: Number(lines) }),
          ...(since === null ? {} : { since: Number(since) }),
          ...(query.get('grep') === null ? {} : { grep: query.get('grep') }),
          ...(query.get('source') === null ? {} : { source: query.get('source') }),
        });
      }
      if (action === 'metrics' && method === 'GET') {
        const report = await this.rpc('metrics', { format: 'json' }) as { processes?: Array<{ name: string }> };
        const found = report.processes?.find((p) => p.name === name);
        if (!found) throw new HttpError(404, `Process "${name}" not found`);
        return found;
      }
      if (method === 'PUT' && (action === 'stop' || action === 'restart')) return this.rpc(action, { name });
      // A reload restarts the process so it picks up its current configuration
      if (method === 'PUT' && action === 'reload') return this.rpc('restart', { name });
      if (action === 'deploy' && method === 'GET') return this.rpc('deploy.status', { name });
      if (action === 'deploy' && method === 'POST') {
        const { strategy, release } = await this.readJson(req);
        return this.rpc('deploy.execute', { name, strategy, release });
      }
      if (action === 'rollback' && method === 'PUT') return this.rpc('deploy.rollback', { name });
      if (method === 'PUT' && action === 'scale') {
        const { instances } = await this.readJson(req);
        return this.rpc('scale', { name, instances });
      }
      throw wrong;
    }
    if (root === 'metrics' && name === undefined) {
      if (method !== 'GET') throw notAllowed;
      return this.rpc('metrics', { format: 'prometheus' });
    }
    if (root === 'daemon' && parts.length === 2) {
      if (name === 'status' && method === 'GET') return this.rpc('daemon.status');
      if (name === 'reload' && method === 'POST') return this.rpc('reload');
    }
    throw wrong;
  }

  // --- WebSocket ---

  private upgrade(req: IncomingMessage, socket: Duplex): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const key = req.headers['sec-websocket-key'];
    const refusal: [number, string] | undefined =
      path !== '/ws' ? [404, 'Not Found']
        : !this.hostAllowed(req) || !this.originAllowed(req) ? [403, 'Forbidden']
          : this.limited(req) ? [429, 'Too Many Requests']
            : !this.authorized(req, true) ? [401, 'Unauthorized']
              : typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13' ? [400, 'Bad Request']
                : this.clients.size >= this.config.maxConnections ? [503, 'Service Unavailable']
                  : undefined;
    if (refusal || typeof key !== 'string') {
      const [status, text] = refusal ?? [400, 'Bad Request'];
      socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const client: Client = { ws: new WebSocketConnection(socket), patterns: new Map() };
    this.clients.add(client);
    client.ws.on('close', () => { this.clients.delete(client); });
    client.ws.on('message', (text) => { this.onMessage(client, text); });
  }

  private onMessage(client: Client, text: string): void {
    const reply = (event: string, data: unknown): void => { client.ws.send(JSON.stringify({ event, data })); };
    let message: { subscribe?: unknown; unsubscribe?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      reply('error', { message: 'Messages must be JSON' });
      return;
    }
    const list = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 100) ? value as string[] : undefined;
    if (message.subscribe !== undefined) {
      const patterns = list(message.subscribe);
      if (!patterns || client.patterns.size + patterns.length > MAX_PATTERNS) {
        reply('error', { message: `subscribe takes up to ${String(MAX_PATTERNS)} patterns, each a non-empty string` });
        return;
      }
      for (const p of patterns) client.patterns.set(p, matcher(p));
    }
    if (message.unsubscribe !== undefined) {
      for (const p of list(message.unsubscribe) ?? []) client.patterns.delete(p);
    }
    reply('subscribed', { patterns: [...client.patterns.keys()] });
  }

  private broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const text = JSON.stringify({ event, data: redact(data) });
    for (const client of this.clients) {
      if (![...client.patterns.values()].some((re) => re.test(event))) continue;
      // A client that does not read must not make the daemon buffer without limit
      if (client.ws.backlog > 4 * 1024 * 1024) client.ws.close(1013);
      else client.ws.send(text);
    }
  }

  /**
   * The bus hands wildcard handlers only the payload, not the event name, so each forwarded
   * event is subscribed by name
   */
  private subscribeEvents(): () => void {
    const sources = [
      'process:started', 'process:stopped', 'process:exit', 'process:crash', 'process:error',
      'process:memory-limit', 'process:cpu-limit',
      'health:status:healthy', 'health:status:unhealthy', 'health:action:restart', 'health:action:stop',
      'deploy:started', 'deploy:progress', 'deploy:succeeded', 'deploy:failed',
      'watch:change', 'cron:run', 'cron:finish', 'config:reloaded', 'daemon:ready', 'daemon:stopped',
    ];
    const offs = sources.map((event) => this.context.events.on(event, (data: unknown) => { this.broadcast(event, data); }));
    offs.push(this.context.events.on('process:log', (data: unknown) => {
      const name = (data as { processName?: string } | undefined)?.processName;
      if (name) this.broadcast(`log:${name}`, data);
    }));
    return () => { for (const off of offs) off(); };
  }

  private async pushMetrics(): Promise<void> {
    const wanted = [...this.clients].some((c) => [...c.patterns.values()].some((re) => re.test('metric:snapshot')));
    if (!wanted) return;
    try {
      this.broadcast('metric:snapshot', await this.rpc('metrics', { format: 'json' }));
    } catch (err) {
      this.context.logger.warn(`Could not collect metrics for WebSocket clients: ${(err as Error).message}`);
    }
  }
}
