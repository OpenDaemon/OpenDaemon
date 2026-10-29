import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, utimesSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gunzipSync } from 'zlib';
import { LogFile, readEntries, type RotationOptions } from '../../packages/plugins/log-manager/src/files.js';

const entry = (message: string, second = 0) => JSON.stringify({
  timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
  level: 'info', pid: 1, processName: 'app', message, source: 'stdout',
});

describe('LogFile', () => {
  let dir: string;
  let path: string;
  const options = (overrides: Partial<RotationOptions> = {}): RotationOptions => ({
    enabled: true, maxSize: 1024 * 1024, maxFiles: 3, compress: false, ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-logfile-'));
    path = join(dir, 'nested', 'app-out.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should batch writes within one tick and create the directory', async () => {
    const file = new LogFile(path, options());
    file.write('a');
    file.write('b');
    expect(existsSync(path)).toBe(false);

    await new Promise((r) => setImmediate(r));
    expect(readFileSync(path, 'utf-8')).toBe('a\nb\n');
    file.close();
  });

  it('should write pending lines on flush and close', () => {
    const file = new LogFile(path, options());
    file.write('x');
    file.close();
    expect(readFileSync(path, 'utf-8')).toBe('x\n');
  });

  it('should append to an existing file and account for its size', () => {
    const file = new LogFile(path, options({ maxSize: 10 }));
    file.write('12345');
    file.close();

    const reopened = new LogFile(path, options({ maxSize: 10 }));
    reopened.write('67890');
    reopened.close();
    // 6 bytes existed, 6 more would pass 10, so the old content was rotated out
    expect(readFileSync(path, 'utf-8')).toBe('67890\n');
    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('12345\n');
  });

  it('should shift rotated files and drop the ones past maxFiles', () => {
    const file = new LogFile(path, options({ maxSize: 4, maxFiles: 2 }));
    for (const line of ['111', '222', '333', '444']) {
      file.write(line);
      file.flush();
    }
    file.close();

    expect(readFileSync(path, 'utf-8')).toBe('444\n');
    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('333\n');
    expect(readFileSync(`${path}.2`, 'utf-8')).toBe('222\n');
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it('should gzip rotated files when compress is on', () => {
    const file = new LogFile(path, options({ maxSize: 4, maxFiles: 2, compress: true }));
    for (const line of ['111', '222', '333']) {
      file.write(line);
      file.flush();
    }
    file.close();

    expect(readdirSync(join(dir, 'nested')).sort()).toEqual(['app-out.log', 'app-out.log.1.gz', 'app-out.log.2.gz']);
    expect(gunzipSync(readFileSync(`${path}.1.gz`)).toString()).toBe('222\n');
    expect(gunzipSync(readFileSync(`${path}.2.gz`)).toString()).toBe('111\n');
  });

  it('should keep growing when rotation is disabled, and keep nothing with maxFiles 0', () => {
    const unbounded = new LogFile(path, options({ maxSize: 4, enabled: false }));
    for (const line of ['111', '222']) { unbounded.write(line); unbounded.flush(); }
    unbounded.close();
    expect(readFileSync(path, 'utf-8')).toBe('111\n222\n');

    const other = join(dir, 'b.log');
    const noHistory = new LogFile(other, options({ maxSize: 4, maxFiles: 0 }));
    for (const line of ['111', '222']) { noHistory.write(line); noHistory.flush(); }
    noHistory.close();
    expect(readFileSync(other, 'utf-8')).toBe('222\n');
    expect(readdirSync(dir).filter((f) => f.startsWith('b.log'))).toEqual(['b.log']);
  });

  it('should truncate the active file and delete rotated ones', () => {
    const file = new LogFile(path, options({ maxSize: 4, maxFiles: 2, compress: true }));
    for (const line of ['111', '222', '333']) { file.write(line); file.flush(); }
    file.write('pending');
    file.truncate();

    expect(readFileSync(path, 'utf-8')).toBe('');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['app-out.log']);
    file.write('after');
    file.close();
    expect(readFileSync(path, 'utf-8')).toBe('after\n');
  });
});

describe('readEntries', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-logread-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('should read rotated (plain and gzip) then active entries, oldest first, skipping bad lines', () => {
    const path = join(dir, 'app-out.log');
    const file = new LogFile(path, { enabled: true, maxSize: 150, maxFiles: 3, compress: true });
    for (let i = 0; i < 6; i++) { file.write(entry(`m${String(i)}`, i)); file.flush(); }
    file.close();
    appendFileSync(path, '{"truncated by a crash\nnot json\n');

    // One ~100-byte entry per file: the active file plus 3 rotated ones keep the newest four
    expect(readEntries(path, 3).map((e) => e.message)).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  it('should return nothing for a missing file and ignore an unreadable gzip', () => {
    const path = join(dir, 'none.log');
    expect(readEntries(path, 3)).toEqual([]);
    writeFileSync(`${path}.1.gz`, 'not gzip');
    writeFileSync(path, `${entry('ok')}\n`);
    expect(readEntries(path, 3).map((e) => e.message)).toEqual(['ok']);
  });
});

describe('LogFile time-based rotation', () => {
  let dir: string;
  let path: string;
  const options = (overrides: Partial<RotationOptions> = {}): RotationOptions => ({
    enabled: true, maxSize: 1024 * 1024, maxFiles: 3, compress: false, ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-logtime-'));
    path = join(dir, 'nested', 'app-out.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = (iso: string): number => new Date(iso).getTime();

  it('should rotate when the day changes, even far below maxSize', () => {
    let now = at('2026-03-10T10:00:00');
    const file = new LogFile(path, options({ interval: 'daily' }), () => now);
    file.write('monday');
    file.flush();
    now = at('2026-03-10T23:59:00');
    file.write('still monday');
    file.flush();
    expect(existsSync(`${path}.1`)).toBe(false);

    now = at('2026-03-11T00:01:00');
    file.write('tuesday');
    file.close();
    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('monday\nstill monday\n');
    expect(readFileSync(path, 'utf-8')).toBe('tuesday\n');
  });

  it('should rotate on the hour with interval hourly, but not within it', () => {
    let now = at('2026-03-10T10:05:00');
    const file = new LogFile(path, options({ interval: 'hourly' }), () => now);
    file.write('a');
    file.flush();
    now = at('2026-03-10T10:55:00');
    file.write('b');
    file.flush();
    expect(existsSync(`${path}.1`)).toBe(false);
    now = at('2026-03-10T11:00:00');
    file.write('c');
    file.close();
    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('a\nb\n');
  });

  it('should rotate a file left over from an earlier day when reopened', () => {
    const now = at('2026-03-12T08:00:00');
    const flat = join(dir, 'old-out.log');
    writeFileSync(flat, 'yesterday\n');
    utimesSync(flat, at('2026-03-11T20:00:00') / 1000, at('2026-03-11T20:00:00') / 1000);
    const file = new LogFile(flat, options({ interval: 'daily' }), () => now);
    file.write('today');
    file.close();
    expect(readFileSync(`${flat}.1`, 'utf-8')).toBe('yesterday\n');
    expect(readFileSync(flat, 'utf-8')).toBe('today\n');
  });

  it('should not rotate by time when rotation is disabled or no interval is set', () => {
    let now = at('2026-03-10T10:00:00');
    const file = new LogFile(path, options(), () => now);
    file.write('a');
    file.flush();
    now = at('2026-04-10T10:00:00');
    file.write('b');
    file.close();
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('should delete rotated files older than maxAge and keep newer ones', () => {
    const now = at('2026-03-20T12:00:00');
    const base = join(dir, 'age-out.log');
    for (const [n, day] of [[1, '2026-03-19'], [2, '2026-03-10'], [3, '2026-03-01']] as const) {
      writeFileSync(`${base}.${String(n)}`, 'x\n');
      utimesSync(`${base}.${String(n)}`, at(`${day}T12:00:00`) / 1000, at(`${day}T12:00:00`) / 1000);
    }
    writeFileSync(`${base}.2.gz`, 'x');
    utimesSync(`${base}.2.gz`, at('2026-03-10T12:00:00') / 1000, at('2026-03-10T12:00:00') / 1000);
    writeFileSync(join(dir, 'age-out.log.bak'), 'keep');
    utimesSync(join(dir, 'age-out.log.bak'), 1, 1);

    const file = new LogFile(base, options({ maxAge: 7 * 86400000 }), () => now);
    file.write('now');
    file.close();
    expect(readdirSync(dir).filter((f) => f.startsWith('age-out')).sort()).toEqual(['age-out.log', 'age-out.log.1', 'age-out.log.bak']);
  });
});
