/**
 * End-to-end: `od runtime` / `od-runtime`, the foreground mode for containers. Runs the built CLI
 * the way a Dockerfile's CMD would: as the main process, logs on stdout, graceful stop on SIGTERM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const CLI = resolve('packages/cli/dist/cli.js');

describe.skipIf(!existsSync(CLI))('od runtime end to end', () => {
  let root: string;
  let project: string;
  const env = (): NodeJS.ProcessEnv => {
    const copy: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete copy['OPENDAEMON_HOME'];
    return copy;
  };

  beforeAll(() => {
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-rt-e2e-'));
    project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'svc.cjs'), "console.log('svc up'); process.on('SIGTERM', () => { console.log('svc got SIGTERM'); process.exit(0); }); setInterval(() => {}, 1000);");
    writeFileSync(join(project, 'once.cjs'), "console.log('ran once'); process.exit(0);");
    writeFileSync(join(project, 'bad.cjs'), "console.error('boom'); process.exit(2);");
  });
  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp dir, left behind */ }
  });

  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: env(), encoding: 'utf-8', timeout: 60000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('prints the app output on stdout and exits 0 when the app finishes', () => {
    const result = run(['runtime', 'once.cjs', '--no-autorestart']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('once | ran once');
    expect(result.stdout).not.toContain(String.fromCharCode(27)); // no spinner codes in a pipe
  });

  it('exits 1 when an app fails and is not restarted', () => {
    const result = run(['runtime', 'bad.cjs', '--no-autorestart']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad | boom');
  });

  it('fails fast on a script that does not exist', () => {
    const result = run(['runtime', 'missing.cjs']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Script not found');
  });

  it('stops the app gracefully on SIGTERM and exits cleanly', async () => {
    const child = spawn(process.execPath, [CLI, 'runtime', 'svc.cjs'], { cwd: project, env: env() });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const deadline = Date.now() + 15000;
    while (!out.includes('svc | svc up') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain('svc | svc up');

    const exited = new Promise<number | null>((done) => { child.on('exit', (code) => { done(code); }); });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });

  it.runIf(process.platform !== 'win32')('works under the od-runtime name', () => {
    const link = join(root, 'od-runtime');
    symlinkSync(CLI, link);
    const result = spawnSync(process.execPath, [link, 'once.cjs', '--no-autorestart'], { cwd: project, env: env(), encoding: 'utf-8', timeout: 60000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('once | ran once');
  });
});
