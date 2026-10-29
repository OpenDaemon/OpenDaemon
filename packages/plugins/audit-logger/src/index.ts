import { readFileSync, existsSync } from 'fs';
import { userInfo } from 'os';
import { resolve } from 'path';
import type { IpcCall, Plugin, PluginContext } from '../../../core/src/index.js';
import { LogFile } from '../../log-manager/src/files.js';

export interface AuditEntry {
  timestamp: string;
  action: string;
  actor: { type: 'ipc' | 'daemon' | 'webui'; connection?: string; user?: string };
  target?: { type: string; name?: string };
  params?: unknown;
  result: 'success' | 'failure';
  error?: string;
  /** ms, for RPC calls */
  duration?: number;
}

const REDACTED = '[redacted]';
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|credential|authorization|private/i;

/**
 * Copy of `value` that is safe to write to a log: values under sensitive keys are masked, and
 * so is every value in a process `env` (apps keep credentials there), whatever it is named.
 * Long strings are cut so a huge parameter cannot bloat the log.
 */
export function redact(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, key, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      key === 'env' ? REDACTED : redact(v, k, depth + 1),
    ]));
  }
  return value;
}

/**
 * RPC methods that only read state: skipped unless `includeReads` is set, since they dominate
 * the log (the dashboard polls them every second) and say nothing about what changed
 */
const READ_ONLY = new Set(['list', 'info', 'logs', 'logs.query', 'logs.follow', 'health', 'metrics', 'cron', 'daemon.status', 'get', 'deploy.status']);

/**
 * Process lifecycle events recorded alongside RPC calls: event -> audit action
 */
const LIFECYCLE: Array<[string, string]> = [
  ['process:started', 'process.started'],
  ['process:stopped', 'process.stopped'],
  ['process:crash', 'process.crash'],
  ['process:memory-limit', 'process.memory-limit'],
  ['process:cpu-limit', 'process.cpu-limit'],
  ['health:action:restart', 'health.restart'],
  ['health:action:stop', 'health.stop'],
  ['watch:change', 'watch.restart'],
  ['deploy:started', 'deploy.started'],
  ['deploy:succeeded', 'deploy.succeeded'],
  ['deploy:failed', 'deploy.failed'],
  ['cron:run', 'cron.run'],
  ['config:reloaded', 'config.reloaded'],
  ['daemon:ready', 'daemon.started'],
  ['daemon:stopped', 'daemon.stopped'],
];

/**
 * Audit Logger Plugin
 * Appends who did what to <home>/audit.log (JSON lines, rotated): RPC calls with redacted
 * parameters, process lifecycle events, and WebUI logins. Secret values never appear.
 */
export class AuditLoggerPlugin implements Plugin {
  name = 'audit-logger';
  version = '1.0.0';
  description = 'Append-only audit trail of operations';
  priority = 3;

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private readonly file: LogFile;
  private readonly path: string;
  private includeReads = false;

  constructor(home: string) {
    this.path = resolve(home, 'audit.log');
    this.file = new LogFile(this.path, { enabled: true, maxSize: 10 * 1024 * 1024, maxFiles: 5, compress: true });
  }

  install(context: PluginContext): void {
    this.context = context;
    this.includeReads = (context.pluginConfig as { includeReads?: boolean } | undefined)?.includeReads === true;

    for (const [event, action] of LIFECYCLE) {
      context.events.on(event, (data: unknown) => {
        const name = (data as { name?: unknown } | undefined)?.name;
        this.record({
          action,
          actor: { type: 'daemon' },
          ...(typeof name === 'string' ? { target: { type: action.split('.')[0] ?? 'daemon', name } } : {}),
          params: data === undefined ? undefined : redact(data),
          result: 'success',
        });
      });
    }

    context.events.on('auth:login', (data: unknown) => {
      const { user, ok, ip } = (data ?? {}) as { user?: string; ok?: boolean; ip?: string };
      this.record({
        action: 'auth.login',
        actor: { type: 'webui', ...(typeof user === 'string' ? { user } : {}) },
        params: { ip },
        result: ok ? 'success' : 'failure',
      });
    });

    context.registerMethod('audit', (params: unknown) => {
      const { lines } = (params ?? {}) as { lines?: number };
      return Promise.resolve(this.tail(typeof lines === 'number' ? lines : 50));
    });
  }

  onStop(): void {
    this.file.close();
  }

  /**
   * Record a completed RPC call (the daemon wires IpcServer.onCall to this)
   */
  recordCall(call: IpcCall): void {
    if (!this.includeReads && READ_ONLY.has(call.method)) return;
    const name = (call.params as { name?: unknown } | undefined)?.name;
    this.record({
      action: call.method,
      actor: { type: 'ipc', connection: call.connection, user: userInfo().username },
      ...(typeof name === 'string' ? { target: { type: call.method.split('.')[0] ?? 'process', name } } : {}),
      params: redact(call.params),
      result: call.ok ? 'success' : 'failure',
      ...(call.error === undefined ? {} : { error: call.error }),
      duration: call.duration,
    });
  }

  record(entry: Omit<AuditEntry, 'timestamp'>): void {
    try {
      this.file.write(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
    } catch (err) {
      // Auditing must never take the daemon down
      this.context.logger.error('Failed to write the audit log', undefined, err as Error);
    }
  }

  /**
   * The newest `lines` entries, oldest first
   */
  tail(lines: number): AuditEntry[] {
    this.file.flush();
    if (!existsSync(this.path)) return [];
    const entries: AuditEntry[] = [];
    for (const line of readFileSync(this.path, 'utf-8').split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // a partial line from a crash
      }
    }
    return lines > 0 ? entries.slice(-lines) : [];
  }
}
