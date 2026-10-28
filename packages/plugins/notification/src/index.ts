import { hostname } from 'os';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { sendMail, type SmtpConfig } from './smtp.js';

export type { SmtpConfig } from './smtp.js';

export type ChannelType = 'webhook' | 'slack' | 'discord' | 'email';

export interface ChannelConfig {
  type: ChannelType;
  /** Endpoint of a webhook, Slack or Discord channel */
  url?: string;
  /** Mail server (email channels) */
  smtp?: SmtpConfig;
  /** Sender address (email channels) */
  from?: string;
  /** Recipient addresses (email channels) */
  to?: string[];
  /** Notification event names this channel receives (default: all) */
  events?: string[];
  /** Extra request headers (webhook) */
  headers?: Record<string, string>;
  /** Request timeout in ms (default 5000) */
  timeout?: number;
}

export interface NotificationConfig {
  channels?: ChannelConfig[];
  /** At most one notification per event type and process in this window, in ms (default 60000; 0 disables) */
  throttle?: number;
  /** Collect notifications for this many ms and send them together (default 0: send immediately) */
  batchWindow?: number;
}

export interface Notification {
  /** Notification event: process:crash, process:unhealthy, ... */
  event: string;
  title: string;
  message: string;
  /** Process name, when the event concerns one */
  name?: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: string;
  host: string;
  data: unknown;
}

/**
 * Event payload value as text; objects become JSON rather than "[object Object]"
 */
function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  return JSON.stringify(value);
}

/**
 * Daemon events that become notifications, and how they read
 */
const SOURCES: Array<{
  source: string;
  event: string;
  severity: Notification['severity'];
  describe: (data: Record<string, unknown>) => { title: string; message: string } | undefined;
}> = [
  {
    source: 'process:crash', event: 'process:crash', severity: 'critical',
    describe: (d) => ({
      title: `Process "${text(d['name'])}" crashed`,
      message: `exit code ${text(d['code'], 'none')}${d['signal'] ? `, signal ${text(d['signal'])}` : ''}; ${text(d['restartCount'], '0')} restart(s) so far`,
    }),
  },
  {
    source: 'health:status:unhealthy', event: 'process:unhealthy', severity: 'critical',
    describe: (d) => ({ title: `Process "${text(d['name'])}" is unhealthy`, message: text(d['message'], 'health check failing') }),
  },
  {
    source: 'health:status:healthy', event: 'process:recovered', severity: 'info',
    describe: (d) => ({ title: `Process "${text(d['name'])}" is healthy again`, message: 'health check passing' }),
  },
  {
    source: 'process:memory-limit', event: 'process:memory-limit', severity: 'warning',
    describe: (d) => ({
      title: `Process "${text(d['name'])}" exceeded its memory limit`,
      message: `${text(d['memory'])} bytes used, limit ${text(d['limit'])}; action: ${text(d['action'], 'restart')}`,
    }),
  },
  {
    source: 'process:cpu-limit', event: 'process:cpu-limit', severity: 'warning',
    describe: (d) => ({
      title: `Process "${text(d['name'])}" exceeded its CPU limit`,
      message: `${Number(d['cpu']).toFixed(1)}% used, limit ${text(d['limit'])}%; action: ${text(d['action'], 'warn')}`,
    }),
  },
  {
    source: 'cron:finish', event: 'cron:failed', severity: 'warning',
    describe: (d) => d['result'] === 'failed'
      ? { title: `Scheduled job "${text(d['name'])}" failed`, message: `exit code ${text(d['exitCode'], 'none')}, attempt ${text(d['attempt'])}` }
      : undefined,
  },
  { source: 'daemon:ready', event: 'daemon:started', severity: 'info', describe: () => ({ title: 'OpenDaemon started', message: 'the daemon is ready' }) },
  { source: 'daemon:stopped', event: 'daemon:stopped', severity: 'info', describe: () => ({ title: 'OpenDaemon stopped', message: 'the daemon has shut down' }) },
];

/**
 * Body each channel type expects
 */
export function formatPayload(type: ChannelType, notes: Notification[]): unknown {
  const text = notes.map((n) => `[${n.severity.toUpperCase()}] ${n.title}: ${n.message}`).join('\n');
  if (type === 'slack') return { text };
  // Discord rejects content over 2000 characters
  if (type === 'discord') return { content: text.length > 2000 ? `${text.slice(0, 1997)}...` : text };
  return notes.length === 1 ? notes[0] : { count: notes.length, notifications: notes };
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme ${target.protocol}`);
  }
  const payload = JSON.stringify(body);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  await new Promise<void>((resolve, reject) => {
    const req = send(target, {
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`HTTP ${String(status)}`));
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timed out after ${String(timeoutMs)}ms`)); });
    req.on('error', reject);
    req.end(payload);
  });
}

interface Pending {
  channel: ChannelConfig;
  notes: Notification[];
  timer?: NodeJS.Timeout;
}

/**
 * Notification Plugin
 * Sends alerts about crashes, unhealthy processes, memory limits, failed jobs and daemon
 * start/stop to webhooks, Slack, Discord and email (SMTP).
 */
export class NotificationPlugin implements Plugin {
  name = 'notification';
  version = '1.0.0';
  description = 'Alerts on critical events';
  priority = 19;

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private config: Required<Pick<NotificationConfig, 'throttle' | 'batchWindow'>> & { channels: ChannelConfig[] } =
    { channels: [], throttle: 60000, batchWindow: 0 };
  private readonly lastSent = new Map<string, number>();
  private readonly batches = new Map<ChannelConfig, Pending>();
  private readonly inflight = new Set<Promise<void>>();

  install(context: PluginContext): void {
    this.context = context;
    const configured = (context.pluginConfig ?? {}) as NotificationConfig;
    this.config = {
      channels: (configured.channels ?? []).filter((c) => this.validChannel(c)),
      throttle: configured.throttle ?? 60000,
      batchWindow: configured.batchWindow ?? 0,
    };
    if (this.config.channels.length === 0) return;

    for (const source of SOURCES) {
      context.events.on(source.source, (data: unknown) => {
        const described = source.describe((data ?? {}) as Record<string, unknown>);
        if (!described) return;
        const name = (data as { name?: unknown } | undefined)?.name;
        this.notify({
          event: source.event,
          ...described,
          ...(typeof name === 'string' ? { name } : {}),
          severity: source.severity,
          timestamp: new Date().toISOString(),
          host: hostname(),
          data,
        });
      });
    }
  }

  /**
   * Send a notification to every channel that subscribed to its event
   */
  notify(note: Notification): void {
    const key = `${note.event}:${note.name ?? ''}`;
    const now = Date.now();
    const last = this.lastSent.get(key);
    if (this.config.throttle > 0 && last !== undefined && now - last < this.config.throttle) return;
    this.lastSent.set(key, now);

    for (const channel of this.config.channels) {
      if (channel.events && !channel.events.includes(note.event)) continue;
      if (this.config.batchWindow > 0) this.enqueue(channel, note);
      else this.deliver(channel, [note]);
    }
  }

  /**
   * Resolves when every notification handed over so far has been sent (or has failed)
   */
  async flush(): Promise<void> {
    for (const pending of this.batches.values()) {
      clearTimeout(pending.timer);
      this.deliver(pending.channel, pending.notes);
    }
    this.batches.clear();
    await Promise.allSettled([...this.inflight]);
  }

  async onStop(): Promise<void> {
    await this.flush();
  }

  private validChannel(channel: ChannelConfig): boolean {
    try {
      if (!(['webhook', 'slack', 'discord', 'email'] as string[]).includes(channel.type)) throw new Error(`unknown channel type "${channel.type as string}"`);
      if (channel.type === 'email') {
        if (!channel.smtp?.host) throw new Error('email channels need smtp.host');
        if (!channel.from) throw new Error('email channels need from');
        if (!Array.isArray(channel.to) || channel.to.length === 0) throw new Error('email channels need at least one recipient in to');
        return true;
      }
      const protocol = new URL(channel.url as string).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') throw new Error('url must be http or https');
      return true;
    } catch (err) {
      this.context.logger.error(`Ignoring notification channel: ${(err as Error).message}`);
      return false;
    }
  }

  private enqueue(channel: ChannelConfig, note: Notification): void {
    let pending = this.batches.get(channel);
    if (!pending) {
      pending = { channel, notes: [] };
      this.batches.set(channel, pending);
      const batch = pending;
      pending.timer = setTimeout(() => {
        this.batches.delete(channel);
        this.deliver(channel, batch.notes);
      }, this.config.batchWindow);
      pending.timer.unref();
    }
    pending.notes.push(note);
  }

  private deliver(channel: ChannelConfig, notes: Notification[]): void {
    const send = channel.type === 'email'
      ? sendMail(channel.smtp as SmtpConfig, {
        from: channel.from as string,
        to: channel.to as string[],
        subject: notes.length === 1 ? `[${(notes[0] as Notification).severity.toUpperCase()}] ${(notes[0] as Notification).title}` : `${String(notes.length)} OpenDaemon notifications`,
        text: notes.map((n) => `[${n.severity.toUpperCase()}] ${n.title}\n${n.message}\nhost: ${n.host}  time: ${n.timestamp}`).join('\n\n'),
      }, channel.timeout)
      : postJson(channel.url as string, formatPayload(channel.type, notes), channel.headers, channel.timeout);
    const task = send
      .catch((err: unknown) => {
        // Never let a broken channel affect the daemon; the host is enough to identify it
        const where = channel.type === 'email' ? (channel.smtp?.host ?? 'smtp') : new URL(channel.url as string).host;
        this.context.logger.warn(`Notification to ${where} failed: ${(err as Error).message}`);
      })
      .finally(() => { this.inflight.delete(task); });
    this.inflight.add(task);
  }
}
