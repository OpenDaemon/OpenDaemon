import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { main } from '../../packages/cli/src/daemon.js';
import { CliClient } from '../../packages/cli/src/client.js';

// The real daemon entry point, in-process: real kernel, plugins and IPC server in a temporary
// home. The TCP port on Windows is fixed, so only the socket platforms run this.
describe.skipIf(process.platform === 'win32')('daemon main() (real)', () => {
  const home = mkdtempSync(join(tmpdir(), 'od-daemon-real-'));
  const cwd = process.cwd();
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const before = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]));
  let exitCode: Promise<number | undefined>;
  let exit: { mockRestore: () => void };

  beforeAll(async () => {
    writeFileSync(join(home, 'opendaemon.config.json'), JSON.stringify({
      plugins: { webui: { port: 0 }, 'ext-hello': { greeting: 'hi' } },
      extensions: ['./ext-hello.mjs', './ext-broken.mjs', './ext-clash.mjs'],
    }));
    writeFileSync(join(home, 'ext-hello.mjs'), `
      export default class Hello {
        name = 'ext-hello'; version = '0.1.0';
        install(context) { context.registerMethod('hello', () => ({ config: context.pluginConfig })); }
      }`);
    writeFileSync(join(home, 'ext-broken.mjs'), 'throw new Error("boom");');
    writeFileSync(join(home, 'ext-clash.mjs'), "export const plugin = { name: 'process-manager', version: '1', install() {} };");
    process.env['OPENDAEMON_HOME'] = join(home, 'state');
    process.chdir(home);
    exitCode = new Promise((resolve) => {
      exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { resolve(code); }) as never);
    });
    await main();
  }, 30000);

  afterAll(() => {
    for (const s of signals) {
      for (const l of process.listeners(s)) if (!before[s]?.includes(l)) process.removeListener(s, l);
    }
    process.stdin.pause();
    process.chdir(cwd);
    delete process.env['OPENDAEMON_HOME'];
    exit.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  it('should write a private pid file, token and socket, and answer daemon.status', async () => {
    const state = join(home, 'state');
    expect(readPid(state)).toBe(process.pid);
    expect(statSync(join(state, 'auth-token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(state, 'opendaemon.sock')).mode & 0o777).toBe(0o600);

    const client = new CliClient();
    await client.connect();
    const status = await client.getDaemonStatus() as { pid: number; status: string };
    expect(status.pid).toBe(process.pid);
    expect(await client.listProcesses()).toEqual([]);
    await client.disconnect();
  });

  it('should load extensions from the config, skipping the ones that fail', async () => {
    const { IpcClient } = await import('@opendaemon/core');
    const authToken = readFileSync(join(home, 'state', 'auth-token'), 'utf-8').trim();
    const client = new IpcClient({ socketPath: join(home, 'state', 'opendaemon.sock'), timeout: 3000, authToken });
    await client.connect();
    expect(await client.call('hello')).toEqual({ config: { greeting: 'hi' } });
    expect(await client.call('list')).toEqual([]); // the real process-manager was not replaced
    await client.disconnect();
  });

  it('should refuse calls without the token', async () => {
    const { IpcClient } = await import('@opendaemon/core');
    const bare = new IpcClient({ socketPath: join(home, 'state', 'opendaemon.sock'), timeout: 3000 });
    await bare.connect();
    await expect(bare.call('daemon.status')).rejects.toThrow();
    await bare.disconnect();
  });

  it('should shut down over IPC and remove its runtime files', async () => {
    const client = new CliClient();
    await client.connect();
    await client.shutdownDaemon();
    expect(await exitCode).toBe(0);
    expect(existsSync(join(home, 'state', 'auth-token'))).toBe(false);
    expect(existsSync(join(home, 'state', 'opendaemon.pid'))).toBe(false);
  }, 30000);
});

function readPid(state: string): number {
  return Number(readFileSync(join(state, 'opendaemon.pid'), 'utf-8'));
}
