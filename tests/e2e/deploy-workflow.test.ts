/**
 * End-to-end: the PM2 deploy workflow with the built CLI. The remote host is this machine: a fake
 * `ssh` on PATH hands the script to a local bash, so git, hooks and `od startOrRestart` all run for real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const CLI = resolve('packages/cli/dist/cli.js');

function strip(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing the CLI's ANSI colours is the point
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}
async function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

describe.skipIf(!existsSync(CLI) || process.platform === 'win32')('od deploy and startOrRestart end to end', () => {
  let root: string;
  let home: string;
  let project: string;
  let app: string;
  const od = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: project, encoding: 'utf-8', timeout: 60000,
      env: { ...process.env, OPENDAEMON_HOME: home, NO_COLOR: '1', PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}` },
    });
    return { status: result.status, out: strip(result.stdout) + strip(result.stderr) };
  };
  const list = () => JSON.parse(od('list', '--json').out) as Array<{ name: string; status: string; pid: number; mode: string }>;
  const logs = (name: string) => od('logs', name, '--raw', '--lines', '50').out;

  beforeAll(() => {
    root = mkdtempSync(join('/tmp', 'od-dep-e2e-'));
    home = join(root, 'home');
    project = join(root, 'project');
    app = join(root, 'server');
    mkdirSync(project);
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'ssh'), '#!/bin/bash\nexec bash -s\n');
    chmodSync(join(root, 'bin', 'ssh'), 0o755);

    // the "repository": a release is a version file plus the app that prints it
    const origin = join(root, 'origin.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', origin]);
    const work = join(root, 'work');
    spawnSync('git', ['clone', origin, work], { stdio: 'ignore' });
    writeFileSync(join(work, 'server.cjs'), "console.log('release ' + require('fs').readFileSync(__dirname + '/VERSION', 'utf-8').trim() + ' env=' + process.env.STAGE); setInterval(() => {}, 1000);");
    writeFileSync(join(work, 'VERSION'), '1');
    git(work, 'add', '-A'); git(work, 'commit', '-m', 'v1'); git(work, 'push', 'origin', 'HEAD:main');

    writeFileSync(join(project, 'ecosystem.config.cjs'), `module.exports = {
      apps: [{ name: 'web', script: '${app}/current/server.cjs', env: { STAGE: 'dev' }, env_production: { STAGE: 'prod' } }],
      deploy: { production: { user: 'deploy', host: ['localhost'], ref: 'origin/main', repo: '${origin}', path: '${app}',
        'post-deploy': "od() { node ${CLI} \\"$@\\"; }; OPENDAEMON_HOME=${home} node ${CLI} startOrRestart ${project}/ecosystem.config.cjs --env production" } },
    };`);
  });
  afterAll(() => {
    od('daemon', 'stop');
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp dir */ }
  });

  it('lists the environments, and explains a wrong one', () => {
    expect(od('deploy', 'ecosystem.config.cjs', 'list').out).toContain('production: localhost');
    const wrong = od('deploy', 'ecosystem.config.cjs', 'staging', 'update');
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain('No deploy.staging');
    expect(od('deploy', 'ecosystem.config.cjs', 'production', 'frobnicate').out).toContain('Unknown deploy command');
  });

  it('sets up the host, deploys the release and starts the app through post-deploy', async () => {
    expect(od('deploy', 'ecosystem.config.cjs', 'production', 'setup').status).toBe(0);
    expect(existsSync(join(app, 'source', '.git'))).toBe(true);
    const result = od('deploy', 'ecosystem.config.cjs', 'production', 'update');
    expect(result.status).toBe(0);
    expect(result.out).toContain('Started web');
    await waitFor(() => list().some((p) => p.name === 'web' && p.status === 'online'));
    await waitFor(() => logs('web').includes('release 1 env=prod'));
  });

  it('deploys a new release: the running app is replaced by the new code, not left on the old', async () => {
    const work = join(root, 'work');
    writeFileSync(join(work, 'VERSION'), '2');
    git(work, 'add', '-A'); git(work, 'commit', '-m', 'v2'); git(work, 'push', 'origin', 'HEAD:main');
    const before = list().find((p) => p.name === 'web')!.pid;
    expect(od('deploy', 'ecosystem.config.cjs', 'production').status).toBe(0);
    await waitFor(() => list().find((p) => p.name === 'web')?.pid !== before);
    await waitFor(() => logs('web').includes('release 2 env=prod'));
  });

  it('reverts to the previous release and reports the current commit', async () => {
    expect(od('deploy', 'ecosystem.config.cjs', 'production', 'revert').status).toBe(0);
    await waitFor(() => logs('web').split('\n').filter(Boolean).pop()?.includes('release 1') === true);
    expect(od('deploy', 'ecosystem.config.cjs', 'production', 'curr').out).toContain('v1');
  });

  it('runs a command on the host with exec, and fails loudly when it fails', () => {
    expect(od('deploy', 'ecosystem.config.cjs', 'production', 'exec', 'cat VERSION > ../exec.txt').status).toBe(0);
    expect(readFileSync(join(app, 'exec.txt'), 'utf-8')).toBe('1');
    const failed = od('deploy', 'ecosystem.config.cjs', 'production', 'exec', 'exit 5');
    expect(failed.status).toBe(1);
    expect(failed.out).toContain('exec failed on localhost (exit 5)');
  });

  it('startOrReload replaces cluster workers one by one with the new config, and start-or-restart starts what is missing', async () => {
    writeFileSync(join(project, 'cluster.cjs'), "console.log('cluster says ' + process.env.GREETING + ' worker ' + process.env.NODE_APP_INSTANCE); setInterval(() => {}, 1000);");
    const eco = (greeting: string) => `module.exports = { apps: [{ name: 'multi', script: './cluster.cjs', instances: 2, exec_mode: 'cluster', env: { GREETING: '${greeting}' } }] };`;
    writeFileSync(join(project, 'cluster.config.cjs'), eco('hello'));
    const first = od('startOrReload', 'cluster.config.cjs');
    expect(first.status).toBe(0);
    expect(first.out).toContain('Started multi with 2 instance(s)');
    await waitFor(() => logs('multi').includes('cluster says hello worker 1'));

    writeFileSync(join(project, 'cluster.config.cjs'), eco('goodbye'));
    const second = od('startOrReload', 'cluster.config.cjs');
    expect(second.status).toBe(0);
    expect(second.out).toContain('Deployed multi (rolling)');
    await waitFor(() => logs('multi').includes('cluster says goodbye worker 0') && logs('multi').includes('cluster says goodbye worker 1'));
    expect(list().find((p) => p.name === 'multi')?.status).toBe('online');
  });
});
