import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveLaunch, isOnPath, findOnPath, quoteForCmd } from '../../packages/plugins/process-manager/src/launch.js';

const posix = process.platform !== 'win32';

describe('resolveLaunch', () => {
  let dir: string;
  const file = (name: string, mode?: number): string => {
    const path = join(dir, name);
    writeFileSync(path, '');
    if (mode !== undefined) chmodSync(path, mode);
    return path;
  };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-launch-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('runs .js, .ts and unknown extensions on node, with interpreter args first', () => {
    const script = file('app.js');
    expect(resolveLaunch({ name: 'a', script, args: ['--port', '1'], interpreterArgs: ['--max-old-space-size=256'] }))
      .toEqual({ command: process.execPath, args: ['--max-old-space-size=256', script, '--port', '1'], node: true });
    expect(resolveLaunch({ name: 'a', script: file('app.ts') })).toMatchObject({ node: true });
    expect(resolveLaunch({ name: 'a', script: file('app.weird') })).toMatchObject({ node: true });
  });

  it('picks the interpreter from the extension', () => {
    const py = file('job.py');
    expect(resolveLaunch({ name: 'a', script: py })).toMatchObject({ command: process.platform === 'win32' ? 'python' : 'python3', args: [py], node: false });
    const sh = file('run.sh');
    expect(resolveLaunch({ name: 'a', script: sh, args: ['x'] })).toEqual({ command: 'bash', args: [sh, 'x'], node: false });
    expect(resolveLaunch({ name: 'a', script: file('x.rb') })).toMatchObject({ command: 'ruby' });
  });

  it('uses an explicit interpreter, and runs the program itself for "none"', () => {
    const script = file('main.ts');
    expect(resolveLaunch({ name: 'a', script, interpreter: 'deno', interpreterArgs: ['run'], args: ['-x'] }))
      .toEqual({ command: 'deno', args: ['run', script, '-x'], node: false });
    expect(resolveLaunch({ name: 'a', script, interpreter: 'none', args: ['go'] }))
      .toEqual({ command: script, args: ['go'], node: false });
  });

  it.runIf(posix)('runs an extensionless executable as it is', () => {
    const binary = file('server', 0o755);
    expect(resolveLaunch({ name: 'a', script: binary })).toEqual({ command: binary, args: [], node: false });
    const notExecutable = file('data', 0o644);
    expect(resolveLaunch({ name: 'a', script: notExecutable })).toMatchObject({ node: true });
  });

  it('runs a command from PATH when there is no such file', () => {
    expect(resolveLaunch({ name: 'a', script: 'node', args: ['-v'] })).toEqual({ command: 'node', args: ['-v'], node: false });
    expect(resolveLaunch({ name: 'a', script: 'node', interpreter: 'none' })).toMatchObject({ command: 'node' });
  });

  it('reports what is missing', () => {
    expect(resolveLaunch({ name: 'a', script: join(dir, 'missing.js') })).toEqual({ error: `Script not found: ${join(dir, 'missing.js')}` });
    expect(resolveLaunch({ name: 'a', script: 'no-such-command-xyz', interpreter: 'none' })).toEqual({ error: 'Command not found: no-such-command-xyz' });
    expect(resolveLaunch({ name: 'a', script: 'no-such-command-xyz', interpreter: 'python3' })).toEqual({ error: 'Script not found: no-such-command-xyz' });
  });

  it('looks commands up on the given PATH only', () => {
    expect(isOnPath('node', { PATH: '' })).toBe(false);
    expect(isOnPath('', {})).toBe(false);
    expect(isOnPath('./node')).toBe(false);
  });

  it('quotes words for cmd.exe only when they need it', () => {
    expect(quoteForCmd('start')).toBe('start');
    expect(quoteForCmd('C:\\Program Files\\nodejs\\npm.cmd')).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmd('a&b')).toBe('"a&b"');
  });

  it('finds the file a command runs from, and nothing for paths or unknown names', () => {
    expect(findOnPath('node')).toBeDefined();
    expect(findOnPath('no-such-command-xyz')).toBeUndefined();
    expect(findOnPath('./node')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('runs npm (a .cmd shim) through a shell on Windows', () => {
    const launch = resolveLaunch({ name: 'a', script: 'npm', args: ['run', 'my script'] });
    expect(launch).toMatchObject({ shell: true, node: false });
    expect((launch as { command: string }).command).toMatch(/npm\.cmd"?$/i);
    expect((launch as { args: string[] }).args).toEqual(['run', '"my script"']);
  });

  it.runIf(process.platform !== 'win32')('never uses a shell off Windows', () => {
    expect(resolveLaunch({ name: 'a', script: 'node' })).not.toHaveProperty('shell');
  });
});
