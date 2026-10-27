import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { encodeFrame, FrameType, parseBytes, serialize } from '../../../core/src/index.js';
import type {
  Plugin,
  PluginContext,
  ProcessConfig,
  ProcessLogEntry,
  LogRotationConfig,
} from '../../../core/src/index.js';
import type { IpcSocket } from '../../../core/src/ipc/types.js';
import { LogFile, readEntries, type RotationOptions } from './files.js';

export { LogFile, readEntries } from './files.js';

export interface LogQuery {
  /** Process name; all processes when omitted */
  name?: string;
  /** Return at most the newest N matching entries (default 100); 0 returns none, like `tail -n 0` */
  lines?: number;
  /** Regular expression matched against the message */
  grep?: string;
  /** Only entries at or after this time (epoch milliseconds) */
  since?: number;
  source?: 'stdout' | 'stderr';
}

interface Follower {
  socket: IpcSocket;
  filter: LogQuery;
  pattern?: RegExp;
}

interface LogManagerConfig extends LogRotationConfig {
  /** Directory for log files; defaults to daemon.logDir, then ./logs */
  directory?: string;
}

const DEFAULT_ROTATION: RotationOptions = {
  enabled: true,
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  compress: true,
};

/**
 * Turn a process name into a safe file name component
 */
function fileBase(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function compilePattern(grep: string | undefined): RegExp | undefined {
  if (grep === undefined || grep === '') return undefined;
  try {
    return new RegExp(grep);
  } catch (err) {
    throw new Error(`Invalid --grep pattern: ${(err as Error).message}`);
  }
}

function matches(entry: ProcessLogEntry, filter: LogQuery, pattern: RegExp | undefined): boolean {
  if (filter.name !== undefined && entry.processName !== filter.name) return false;
  if (filter.source !== undefined && entry.source !== filter.source) return false;
  if (filter.since !== undefined && Date.parse(entry.timestamp) < filter.since) return false;
  return pattern === undefined || pattern.test(entry.message);
}

/**
 * Log Manager Plugin
 * Persists process output as JSON lines (<logDir>/<name>-out.log and -error.log) with
 * size-based rotation and gzip, and serves queries and live follow over IPC.
 */
export class LogManagerPlugin implements Plugin {
  name = 'log-manager';
  version = '1.0.0';
  description = 'Persistent, rotated process logs with search and follow';
  priority = 12;

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private logDir = resolve('logs');
  private defaults: RotationOptions = DEFAULT_ROTATION;
  private readonly files = new Map<string, { file: LogFile; options: RotationOptions }>();
  private readonly followers = new Set<Follower>();

  install(context: PluginContext): void {
    this.context = context;
    const pluginConfig = (context.pluginConfig ?? {}) as LogManagerConfig;
    this.logDir = resolve(pluginConfig.directory ?? context.config.daemon?.logDir ?? './logs');
    this.defaults = this.rotationOptions(pluginConfig, DEFAULT_ROTATION);

    context.events.on('process:log', (data: unknown) => {
      this.record(data as ProcessLogEntry);
    });

    // The Promise executor turns a synchronous throw (e.g. a bad --grep) into a rejection
    const handle = <T>(run: () => T) => new Promise<T>((resolveCall) => { resolveCall(run()); });
    context.registerMethod('logs.query', (params: unknown) => handle(() => this.query((params ?? {}) as LogQuery)));
    context.registerMethod('logs.follow', (params: unknown, socket: IpcSocket) =>
      handle(() => this.follow((params ?? {}) as LogQuery, socket)));
    context.registerMethod('logs.flush', (params: unknown) =>
      handle(() => this.flush((params as { name?: string } | undefined)?.name)));
  }

  onStop(): void {
    for (const { file } of this.files.values()) {
      file.close();
    }
    this.files.clear();
    this.followers.clear();
  }

  /**
   * Persist one entry and push it to matching followers
   */
  record(entry: ProcessLogEntry): void {
    this.fileFor(entry.processName, entry.source).file.write(JSON.stringify(entry));

    for (const follower of this.followers) {
      if (matches(entry, follower.filter, follower.pattern)) {
        const notification = { jsonrpc: '2.0' as const, method: 'log', params: entry };
        follower.socket.write(encodeFrame(FrameType.JSON_RPC_NOTIFICATION, serialize(notification)));
      }
    }
  }

  /**
   * Matching entries across stdout/stderr (and rotated files), oldest first
   */
  query(filter: LogQuery): ProcessLogEntry[] {
    const pattern = compilePattern(filter.grep);
    // Make buffered lines visible to the read below
    for (const { file } of this.files.values()) {
      file.flush();
    }

    const names = filter.name === undefined ? this.knownNames() : [filter.name];
    const entries: ProcessLogEntry[] = [];
    for (const name of names) {
      for (const source of ['stdout', 'stderr'] as const) {
        if (filter.source !== undefined && filter.source !== source) continue;
        const { file, options } = this.fileFor(name, source);
        entries.push(...readEntries(file.path, options.maxFiles).filter((e) => matches(e, filter, pattern)));
      }
    }

    // Stable sort keeps file order for entries that share a timestamp
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const lines = filter.lines ?? 100;
    return lines > 0 ? entries.slice(-lines) : [];
  }

  /**
   * Stream future entries matching the filter to this connection until it closes
   */
  follow(filter: LogQuery, socket: IpcSocket): { following: true } {
    const follower: Follower = { socket, filter };
    const pattern = compilePattern(filter.grep);
    if (pattern) follower.pattern = pattern;
    this.followers.add(follower);
    socket.on('close', () => { this.followers.delete(follower); });
    return { following: true };
  }

  /**
   * Empty the log files of one process, or of all of them
   */
  flush(name?: string): { flushed: string[] } {
    const names = name === undefined ? this.knownNames() : [name];
    for (const n of names) {
      for (const source of ['stdout', 'stderr'] as const) {
        this.fileFor(n, source).file.truncate();
      }
    }
    return { flushed: names };
  }

  /**
   * Process names that have log files on disk or were seen this session
   */
  private knownNames(): string[] {
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      names.add(key.slice(0, key.lastIndexOf(':')));
    }
    if (existsSync(this.logDir)) {
      for (const file of readdirSync(this.logDir)) {
        const match = /^(.*)-(out|error)\.log$/.exec(file);
        // File names are sanitized, so prefer the real name from an open file when known
        if (match?.[1] && ![...names].some((n) => fileBase(n) === match[1])) names.add(match[1]);
      }
    }
    return [...names].sort();
  }

  private fileFor(name: string, source: 'stdout' | 'stderr'): { file: LogFile; options: RotationOptions } {
    const key = `${name}:${source}`;
    let entry = this.files.get(key);
    if (!entry) {
      const processConfig = (this.context.getPlugin('process-manager') as unknown as
        { getProcessConfig?: (n: string) => ProcessConfig | undefined } | undefined)?.getProcessConfig?.(name);
      const options = this.rotationOptions(processConfig?.logRotation ?? {}, this.defaults);
      const path = join(this.logDir, `${fileBase(name)}-${source === 'stdout' ? 'out' : 'error'}.log`);
      entry = { file: new LogFile(path, options), options };
      this.files.set(key, entry);
    }
    return entry;
  }

  private rotationOptions(config: LogRotationConfig, base: RotationOptions): RotationOptions {
    const maxSize = config.maxSize === undefined ? undefined : parseBytes(config.maxSize);
    if (config.maxSize !== undefined && maxSize === undefined) {
      this.context.logger.warn(`Ignoring invalid log maxSize "${String(config.maxSize)}"`);
    }
    return {
      enabled: config.enabled ?? base.enabled,
      maxSize: maxSize ?? base.maxSize,
      maxFiles: config.maxFiles ?? base.maxFiles,
      compress: config.compress ?? base.compress,
    };
  }
}
