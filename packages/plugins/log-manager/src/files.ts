import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname } from 'path';
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

  constructor(readonly path: string, private readonly options: RotationOptions) {}

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
    if (this.options.enabled && this.size > 0 && this.size + data.length > this.options.maxSize) {
      this.rotate();
      writeSync(this.open(), data);
    } else {
      writeSync(fd, data);
    }
    this.size += data.length;
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
      this.size = statSync(this.path).size;
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
