/**
 * End-to-end: `od serve` (pm2 serve) and the PM2 start flags that shape logs, node and restarts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { request } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';

const CLI = resolve('packages/cli/dist/cli.js');

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing the CLI's ANSI colours is the point
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const freePort = (): Promise<number> => new Promise((done) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => { done(port); }); });
});
/** A raw request: the path is sent as given (fetch would tidy ../ away before it left) */
const get = (port: number, path: string, method = 'GET'): Promise<{ status: number; body: string; type: string }> => new Promise((done, fail) => {
  const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
    let body = '';
    res.on('data', (c: Buffer) => { body += c.toString(); });
    res.on('end', () => { done({ status: res.statusCode ?? 0, body, type: res.headers['content-type'] ?? '' }); });
  });
  req.on('error', fail);
  req.end();
});

describe.skipIf(!existsSync(CLI))('od serve and start flags end to end', () => {
  let root: string;
  let home: string;
  let project: string;
  const od = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1' }, encoding: 'utf-8', timeout: 40000 });
    return { status: result.status, out: strip(result.stdout) + strip(result.stderr) };
  };
  const list = () => JSON.parse(od('list', '--json').out) as Array<{ name: string; status: string; restartCount: number }>;

  beforeAll(() => {
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'od-serve-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(join(project, 'site', 'docs'), { recursive: true });
    writeFileSync(join(project, 'site', 'index.html'), '<h1>home</h1>');
    writeFileSync(join(project, 'site', 'docs', 'index.html'), '<h1>docs</h1>');
    writeFileSync(join(project, 'site', 'app.js'), 'console.log(1)');
    writeFileSync(join(project, 'secret.txt'), 'outside the served directory');
  });
  afterAll(() => {
    od('daemon', 'stop');
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp dir */ }
  });

  it('serves a directory as a managed app, with types, index files and 404s', async () => {
    const port = await freePort();
    const started = od('serve', 'site', String(port), '--host', '127.0.0.1');
    expect(started.status).toBe(0);
    expect(started.out).toContain(`Serving`);
    await waitFor(async () => (await get(port, '/').catch(() => ({ status: 0 }))).status === 200);
    expect(await get(port, '/')).toMatchObject({ status: 200, body: '<h1>home</h1>', type: 'text/html; charset=utf-8' });
    expect(await get(port, '/docs/')).toMatchObject({ status: 200, body: '<h1>docs</h1>' });
    expect(await get(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript' });
    expect((await get(port, '/missing')).status).toBe(404);
    expect((await get(port, '/', 'HEAD')).status).toBe(200);
    expect((await get(port, '/', 'POST')).status).toBe(405);
    expect(list().some((p) => p.name === `serve-${String(port)}` && p.status === 'online')).toBe(true);
  });

  it('never serves a file outside the directory', async () => {
    const port = await freePort();
    od('serve', 'site', String(port), '--host', '127.0.0.1', '--name', 'jail');
    await waitFor(async () => (await get(port, '/').catch(() => ({ status: 0 }))).status === 200);
    for (const path of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/docs/../../secret.txt', '/%00', '/%']) {
      const reply = await get(port, path);
      expect(reply.body, path).not.toContain('outside the served directory');
    }
  });

  it('falls back to index.html for single page apps, but not for missing files', async () => {
    const port = await freePort();
    od('serve', 'site', String(port), '--host', '127.0.0.1', '--spa', '--name', 'spa');
    await waitFor(async () => (await get(port, '/').catch(() => ({ status: 0 }))).status === 200);
    expect(await get(port, '/some/client/route')).toMatchObject({ status: 200, body: '<h1>home</h1>' });
    expect((await get(port, '/missing.js')).status).toBe(404);
  });

  it('refuses a missing directory and a bad port', () => {
    expect(od('serve', 'nope', '8080').out).toContain('Directory not found');
    expect(od('serve', 'site', '99999').out).toContain('Invalid port');
  });

  it('writes plain-text log files with --output, --error and --time', async () => {
    writeFileSync(join(project, 'talk.cjs'), "console.log('said out'); console.error('said err'); setInterval(() => {}, 1000);");
    od('start', 'talk.cjs', '--output', 'talk.out', '--error', 'talk.err', '--time');
    await waitFor(() => existsSync(join(project, 'talk.err')) && existsSync(join(project, 'talk.out')));
    await waitFor(() => readFileSync(join(project, 'talk.out'), 'utf-8').includes('said out'));
    expect(readFileSync(join(project, 'talk.out'), 'utf-8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z said out\n/);
    expect(readFileSync(join(project, 'talk.err'), 'utf-8')).toContain('said err');
  });

  it('passes --node-args to node, and --stop-exit-codes keeps a clean "done" exit from restarting', async () => {
    writeFileSync(join(project, 'flags.cjs'), "console.log('flags ' + process.execArgv.join(' ')); setInterval(() => {}, 1000);");
    od('start', 'flags.cjs', '--node-args=--no-warnings --stack-trace-limit=7');
    // without the =, the value would look like another option: say so instead of ignoring it
    expect(od('start', 'flags.cjs', '--name', 'f2', '--node-args', '--no-warnings').out).toContain('--node-args needs a value');
    await waitFor(() => od('logs', 'flags', '--raw').out.includes('flags'));
    expect(od('logs', 'flags', '--raw').out).toContain('flags --no-warnings --stack-trace-limit=7');

    writeFileSync(join(project, 'quit.cjs'), 'process.exit(42);');
    od('start', 'quit.cjs', '--stop-exit-codes', '42,43', '--restart-delay', '50');
    await waitFor(() => list().find((p) => p.name === 'quit')?.status === 'errored');
    expect(list().find((p) => p.name === 'quit')?.restartCount).toBe(0);
    expect(od('start', 'quit.cjs', '--name', 'q2', '--stop-exit-codes', 'x').out).toContain('Invalid --stop-exit-codes');
  });

  it('starts with --wait-ready and --ignore-watch together with --watch', async () => {
    writeFileSync(join(project, 'ready.cjs'), "setTimeout(() => process.send('ready'), 400); setInterval(() => {}, 1000);");
    const started = od('start', 'ready.cjs', '--wait-ready', '--listen-timeout', '5000', '--watch', '--ignore-watch', 'node_modules,logs');
    expect(started.status).toBe(0);
    await waitFor(() => list().find((p) => p.name === 'ready')?.status === 'online');
  });
});
