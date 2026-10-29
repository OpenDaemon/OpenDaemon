import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { NotificationPlugin, formatPayload, type Notification } from '../../packages/plugins/notification/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

interface Received { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }

describe('NotificationPlugin', () => {
  let server: Server;
  let base: string;
  let status = 200;
  let events: EventBus;
  let plugin: NotificationPlugin;
  const received: Received[] = [];
  const warnings: string[] = [];

  function install(config: Record<string, unknown>): void {
    plugin = new NotificationPlugin();
    const logger = new Logger('notify-test');
    logger.warn = (message: string) => { warnings.push(message); };
    plugin.install({
      config: {}, pluginConfig: config, events, logger, store: new StateStore(),
      registerMethod: () => {}, getPlugin: () => undefined,
    } as unknown as PluginContext);
  }

  const settle = async () => { await plugin.flush(); };

  beforeEach(async () => {
    received.length = 0;
    warnings.length = 0;
    status = 200;
    events = new EventBus();
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await plugin.onStop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('should POST a crash as a JSON notification with custom headers', async () => {
    install({ channels: [{ type: 'webhook', url: `${base}/hook`, headers: { 'X-Token': 'abc' } }] });
    events.emit('process:crash', { name: 'api', code: 1, signal: null, restartCount: 2 });
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe('/hook');
    expect(received[0]?.headers['x-token']).toBe('abc');
    expect(received[0]?.body).toMatchObject({
      event: 'process:crash', name: 'api', severity: 'critical',
      title: 'Process "api" crashed', message: 'exit code 1; 2 restart(s) so far',
    });
  });

  it('should announce deploys, stressing failures that were not rolled back', async () => {
    install({ channels: [{ type: 'webhook', url: base }], throttle: 0 });
    events.emit('deploy:succeeded', { name: 'web', strategy: 'canary', version: '2.0' });
    events.emit('deploy:failed', { name: 'web', strategy: 'rolling', error: 'boom', rolledBack: false });
    await settle();
    expect(received.map((r) => (r.body as { title: string; message: string; severity: string }))).toEqual([
      expect.objectContaining({ title: 'Deployed "web"', message: 'canary 2.0', severity: 'info' }),
      expect.objectContaining({ title: 'Deploy of "web" failed', message: 'rolling: boom (NOT rolled back)', severity: 'critical' }),
    ]);
  });

  it('should map daemon events to notifications and only report failed cron runs', async () => {
    install({ channels: [{ type: 'webhook', url: base }], throttle: 0 });
    events.emit('health:status:unhealthy', { name: 'api', message: 'HTTP 500' });
    events.emit('health:status:healthy', { name: 'api' });
    events.emit('process:memory-limit', { name: 'api', memory: 600, limit: 500 });
    events.emit('cron:finish', { name: 'job', result: 'succeeded', exitCode: 0, attempt: 1 });
    events.emit('cron:finish', { name: 'job', result: 'failed', exitCode: 3, attempt: 2 });
    events.emit('daemon:ready');
    events.emit('daemon:stopped');
    await settle();

    expect(received.map((r) => (r.body as Notification).event).sort()).toEqual([
      'cron:failed', 'daemon:started', 'daemon:stopped', 'process:memory-limit', 'process:recovered', 'process:unhealthy',
    ]);
    const failed = received.find((r) => (r.body as Notification).event === 'cron:failed')?.body as Notification;
    expect(failed.message).toBe('exit code 3, attempt 2');
  });

  it('should only send events a channel subscribed to', async () => {
    install({ channels: [{ type: 'webhook', url: `${base}/crashes`, events: ['process:crash'] }, { type: 'webhook', url: `${base}/all` }], throttle: 0 });
    events.emit('process:crash', { name: 'a', code: 1 });
    events.emit('process:memory-limit', { name: 'a', memory: 1, limit: 1 });
    await settle();

    expect(received.filter((r) => r.path === '/crashes')).toHaveLength(1);
    expect(received.filter((r) => r.path === '/all')).toHaveLength(2);
  });

  it('should format Slack and Discord bodies', async () => {
    install({ channels: [{ type: 'slack', url: `${base}/slack` }, { type: 'discord', url: `${base}/discord` }] });
    events.emit('process:crash', { name: 'api', code: 137, signal: 'SIGKILL', restartCount: 0 });
    await settle();

    const slack = received.find((r) => r.path === '/slack')?.body as { text: string };
    expect(slack.text).toBe('[CRITICAL] Process "api" crashed: exit code 137, signal SIGKILL; 0 restart(s) so far');
    expect(received.find((r) => r.path === '/discord')?.body).toEqual({ content: slack.text });

    const long = Array.from({ length: 3 }, () => ({ severity: 'info', title: 'x'.repeat(900), message: '' }) as Notification);
    expect((formatPayload('discord', long) as { content: string }).content).toHaveLength(2000);
  });

  it('should throttle repeats per event and process, but not different processes', async () => {
    install({ channels: [{ type: 'webhook', url: base }], throttle: 60000 });
    events.emit('process:crash', { name: 'a', code: 1 });
    events.emit('process:crash', { name: 'a', code: 1 });
    events.emit('process:crash', { name: 'b', code: 1 });
    await settle();
    expect(received.map((r) => (r.body as Notification).name).sort()).toEqual(['a', 'b']);
  });

  it('should batch notifications inside the window into one request per channel', async () => {
    install({ channels: [{ type: 'webhook', url: base }, { type: 'slack', url: `${base}/slack` }], batchWindow: 100, throttle: 0 });
    events.emit('process:crash', { name: 'a', code: 1 });
    events.emit('process:crash', { name: 'b', code: 1 });
    expect(received).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    await settle();

    expect(received).toHaveLength(2);
    const webhook = received.find((r) => r.path === '/')?.body as { count: number; notifications: Notification[] };
    expect(webhook.count).toBe(2);
    expect((received.find((r) => r.path === '/slack')?.body as { text: string }).text.split('\n')).toHaveLength(2);
  });

  it('should flush a pending batch when the plugin stops', async () => {
    install({ channels: [{ type: 'webhook', url: base }], batchWindow: 60000 });
    events.emit('process:crash', { name: 'a', code: 1 });
    await plugin.onStop();
    expect(received).toHaveLength(1);
  });

  it('should log a failed delivery by host and keep going', async () => {
    status = 500;
    install({ channels: [{ type: 'webhook', url: base }], throttle: 0 });
    events.emit('process:crash', { name: 'a', code: 1 });
    await settle();
    expect(warnings).toEqual([`Notification to 127.0.0.1:${new URL(base).port} failed: HTTP 500`]);

    install({ channels: [{ type: 'webhook', url: 'http://127.0.0.1:1', timeout: 500 }], throttle: 0 });
    events.emit('process:crash', { name: 'a', code: 1 });
    await settle();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/failed: .*ECONNREFUSED/);
  });

  it('should ignore invalid channels and send nothing without channels', async () => {
    install({ channels: [{ type: 'smtp', url: base }, { type: 'webhook', url: 'ftp://x' }, { type: 'webhook', url: 'not a url' }] });
    events.emit('process:crash', { name: 'a', code: 1 });
    await settle();
    expect(received).toEqual([]);
  });
});
