import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import type { ProcessLogEntry } from '../../../core/src/index.js';

export interface RotationOptions {
  enabled: boolean;
  /** Rotate once the active file would grow past this many bytes */
  maxSize: number;
  /** Rotated files kept next to the active one (name.log.1 … name.log.N) */
  maxFiles: number;
  /** gzip rotated files (name.log.1.gz) */
  compress: boolean;
  /** Also rotate when the local hour or day changes */
  interval?: 'hourly' | 'daily';
  /** Delete rotated files not modified for this many milliseconds */
  maxAge?: number;
}

/** Local-time bucket a timestamp falls into, so a change of key means a new hour or day */
function periodKey(interval: 'hourly' | 'daily', time: number): string {
  const d = new Date(time);
  const day = `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
  return interval === 'hourly' ? `${day}-${String(d.getHours())}` : day;
}

/**
 * Append-only JSON-lines log file with size-based rotation.
 *
 * Writes are batched per event-loop turn and flushed synchronously, so a burst of
 * output costs one write call and nothing is lost when the daemon exits right after.
 * Compression is synchronous too: it is bounded by maxSize and keeps rotation ordering simple.
 */
export class LogFile {
  private fd: number | undefined;
  private size = 0;
  private pending: string[] = [];
  private scheduled = false;
  /** When the active file was last written (its mtime until this instance writes) */
  private lastWrite = 0;

  constructor(readonly path: string, private readonly options: RotationOptions, private readonly clock: () => number = Date.now) {}

  write(line: string): void {
    this.pending.push(`${line}\n`);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => { this.flush(); });
    }
  }

  flush(): void {
    this.scheduled = false;
    if (this.pending.length === 0) {
      return;
    }
    const data = Buffer.from(this.pending.join(''));
    this.pending = [];

    const fd = this.open();
    const now = this.clock();
    const { interval } = this.options;
    const newPeriod = interval !== undefined && this.size > 0 && periodKey(interval, this.lastWrite) !== periodKey(interval, now);
    if (this.options.enabled && this.size > 0 && (newPeriod || this.size + data.length > this.options.maxSize)) {
      this.rotate();
      writeSync(this.open(), data);
    } else {
      writeSync(fd, data);
    }
    this.size += data.length;
    this.lastWrite = now;
  }

  close(): void {
    this.flush();
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  /**
   * Drop all content: empty the active file and delete rotated ones
   */
  truncate(): void {
    this.pending = [];
    this.close();
    if (existsSync(this.path)) {
      writeFileSync(this.path, '');
    }
    for (let i = 1; i <= Math.max(this.options.maxFiles, 1); i++) {
      for (const file of [`${this.path}.${String(i)}`, `${this.path}.${String(i)}.gz`]) {
        if (existsSync(file)) unlinkSync(file);
      }
    }
    this.size = 0;
  }

  private open(): number {
    if (this.fd === undefined) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.fd = openSync(this.path, 'a');
      const stat = statSync(this.path);
      this.size = stat.size;
      this.lastWrite = stat.size > 0 ? stat.mtimeMs : this.clock();
      this.prune();
    }
    return this.fd;
  }

  private rotate(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }

    // Shift name.log.(i) -> name.log.(i+1), oldest first, dropping the one past maxFiles
    for (let i = this.options.maxFiles; i >= 1; i--) {
      for (const ext of ['', '.gz']) {
        const from = `${this.path}.${String(i)}${ext}`;
        if (!existsSync(from)) continue;
        if (i === this.options.maxFiles) unlinkSync(from);
        else renameSync(from, `${this.path}.${String(i + 1)}${ext}`);
      }
    }

    if (this.options.maxFiles === 0) {
      unlinkSync(this.path);
    } else if (this.options.compress) {
      writeFileSync(`${this.path}.1.gz`, gzipSync(readFileSync(this.path)));
      unlinkSync(this.path);
    } else {
      renameSync(this.path, `${this.path}.1`);
    }
    this.size = 0;
    this.prune();
  }

  /**
   * Delete rotated files that have not changed within maxAge
   */
  private prune(): void {
    const { maxAge } = this.options;
    if (maxAge === undefined || !this.options.enabled) return;
    const prefix = `${basename(this.path)}.`;
    const cutoff = this.clock() - maxAge;
    for (const file of readdirSync(dirname(this.path))) {
      if (!file.startsWith(prefix) || !/^\d+(\.gz)?$/.test(file.slice(prefix.length))) continue;
      const full = join(dirname(this.path), file);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Read a log file and its rotated predecessors, oldest first. Lines that are not valid
 * entries (e.g. a partial line from a crash) are skipped.
 */
export function readEntries(path: string, maxFiles: number): ProcessLogEntry[] {
  const files: string[] = [];
  for (let i = Math.max(maxFiles, 1); i >= 1; i--) {
    for (const ext of ['.gz', '']) {
      const file = `${path}.${String(i)}${ext}`;
      if (existsSync(file)) files.push(file);
    }
  }
  if (existsSync(path)) files.push(path);

  const entries: ProcessLogEntry[] = [];
  for (const file of files) {
    let content: string;
    try {
      const raw = readFileSync(file);
      content = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as ProcessLogEntry;
        if (typeof entry.timestamp === 'string' && typeof entry.message === 'string') entries.push(entry);
      } catch {
        // skip
      }
    }
  }
  return entries;
}
