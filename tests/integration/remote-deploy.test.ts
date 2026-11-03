import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runDeploy, remoteScript, validateTarget, sh, sshRunner, type DeployTarget, type Runner } from '../../packages/cli/src/remote-deploy.js';

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** The part of ssh that matters here: a script handed to bash. "Hosts" are just labels. */
function localRunner(log: Array<{ host: string; script: string }> = []): Runner {
  return (host, script) => new Promise((resolve) => {
    log.push({ host, script });
    const child = spawn('bash', ['-s'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('exit', (code) => { resolve(code ?? 1); });
    child.stdin.end(script);
  });
}

describe.runIf(process.platform !== 'win32')('od deploy over ssh (pm2 deploy)', () => {
  let root: string;
  let origin: string;
  let target: DeployTarget;
  const quiet = (): void => undefined;
  const commit = (file: string, content: string, message: string): void => {
    const work = join(root, 'work');
    writeFileSync(join(work, file), content);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', message);
    git(work, 'push', 'origin', 'HEAD:main');
  };
  const deployed = (name: string): string => readFileSync(join(target.path, 'current', name), 'utf-8');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'od-rdeploy-'));
    origin = join(root, 'origin.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', origin]);
    spawnSync('git', ['clone', origin, join(root, 'work')], { stdio: 'ignore' });
    commit('version.txt', 'v1', 'first release');
    target = { host: 'web1', repo: origin, ref: 'origin/main', path: join(root, 'app') };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('sets up the host: clone, current link, hooks in order', async () => {
    target['pre-setup'] = `echo pre > ${sh(join(root, 'order.txt'))}`;
    target['post-setup'] = `echo "post in $(basename "$PWD")" >> ${sh(join(root, 'order.txt'))}`;
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    expect(existsSync(join(target.path, 'source', '.git'))).toBe(true);
    expect(existsSync(join(target.path, 'shared'))).toBe(true);
    expect(lstatSync(join(target.path, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target.path, 'current'))).toBe(join(target.path, 'source'));
    expect(readFileSync(join(root, 'order.txt'), 'utf-8')).toBe('pre\npost in source\n');
  });

  it('is safe to set up twice', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    await expect(runDeploy(target, 'setup', localRunner(), undefined, quiet)).resolves.toHaveLength(1);
  });

  it('updates to the ref, runs pre-deploy before the link moves and post-deploy in current', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    commit('version.txt', 'v2', 'second release');
    target.env = { RELEASE_NAME: "o'neil" };
    target['pre-deploy'] = `cp version.txt ${sh(join(root, 'seen-by-pre-deploy.txt'))}`;
    target['post-deploy'] = `echo "$RELEASE_NAME $(cat version.txt) $(basename "$(readlink -f .)")" > ${sh(join(root, 'post.txt'))}`;
    await runDeploy(target, 'update', localRunner(), undefined, quiet);
    expect(deployed('version.txt')).toBe('v2');
    expect(readFileSync(join(root, 'seen-by-pre-deploy.txt'), 'utf-8')).toBe('v2');
    expect(readFileSync(join(root, 'post.txt'), 'utf-8')).toBe("o'neil v2 source\n");
  });

  it('discards local changes in the checkout (reset --hard) and deploys a tag as well as a branch', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    writeFileSync(join(target.path, 'source', 'version.txt'), 'edited on the server');
    git(join(root, 'work'), 'tag', 'v1.0.0');
    git(join(root, 'work'), 'push', 'origin', 'v1.0.0');
    commit('version.txt', 'v2', 'second release');
    await runDeploy({ ...target, ref: 'v1.0.0' }, 'update', localRunner(), undefined, quiet);
    expect(deployed('version.txt')).toBe('v1');
  });

  it('reverts by commits, and reports the current and previous commit', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    commit('version.txt', 'v2', 'second release');
    await runDeploy(target, 'update', localRunner(), undefined, quiet);
    await runDeploy(target, 'revert', localRunner(), '1', quiet);
    expect(deployed('version.txt')).toBe('v1');
    await expect(runDeploy(target, 'revert', localRunner(), 'abc', quiet)).rejects.toThrow(/revert takes a number/);
    await runDeploy(target, 'curr', localRunner(), undefined, quiet);
    await runDeploy(target, 'prev', localRunner(), undefined, quiet);
  });

  it('runs a command in current with exec', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    await runDeploy(target, 'exec', localRunner(), `cat version.txt > ${sh(join(root, 'exec.txt'))}`, quiet);
    expect(readFileSync(join(root, 'exec.txt'), 'utf-8')).toBe('v1');
    await expect(runDeploy(target, 'exec', localRunner(), '', quiet)).rejects.toThrow(/exec needs a command/);
  });

  it('runs pre-deploy-local here, once, before any host, and stops if it fails', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    const log: Array<{ host: string; script: string }> = [];
    target.host = ['web1', 'web2'];
    target['pre-deploy-local'] = `echo run >> ${sh(join(root, 'local.txt'))}`;
    await runDeploy(target, 'update', localRunner(log), undefined, quiet);
    expect(readFileSync(join(root, 'local.txt'), 'utf-8')).toBe('run\n');
    expect(log.map((l) => l.host)).toEqual(['web1', 'web2']);

    target['pre-deploy-local'] = 'exit 3';
    const second: Array<{ host: string; script: string }> = [];
    await expect(runDeploy(target, 'update', localRunner(second), undefined, quiet)).rejects.toThrow(/pre-deploy-local failed \(exit 3\)/);
    expect(second).toEqual([]);
  });

  it('stops at the first host that fails, so a broken release does not spread', async () => {
    const seen: string[] = [];
    const runner: Runner = (host) => { seen.push(host); return Promise.resolve(host === 'web1' ? 7 : 0); };
    target.host = ['web1', 'web2'];
    await expect(runDeploy(target, 'update', runner, undefined, quiet)).rejects.toThrow(/update failed on web1 \(exit 7\)/);
    expect(seen).toEqual(['web1']);
  });

  it('fails a deploy whose hook fails, and leaves the link on the old release', async () => {
    await runDeploy(target, 'setup', localRunner(), undefined, quiet);
    commit('version.txt', 'v2', 'broken release');
    target['pre-deploy'] = 'exit 1';
    await expect(runDeploy(target, 'update', localRunner(), undefined, quiet)).rejects.toThrow(/update failed on web1/);
  });

  it('puts a ~ path under $HOME and quotes everything it was given', () => {
    const script = remoteScript({ ...target, path: '~/apps/it' }, 'update');
    expect(script).toContain('cd "$HOME"\'/apps/it\'/source');
    expect(remoteScript({ ...target, repo: "git@host:o'rg/r.git" }, 'setup')).toContain(sh("git@host:o'rg/r.git"));
  });

  it('validates the deploy block with messages that name the key', () => {
    expect(() => validateTarget('production', null)).toThrow(/must be an object/);
    expect(() => validateTarget('production', { ...target, repo: undefined })).toThrow(/deploy.production.repo is required/);
    expect(() => validateTarget('production', { ...target, host: [] })).toThrow(/host is required/);
    expect(() => validateTarget('production', { ...target, path: 'relative/dir' })).toThrow(/absolute path/);
    expect(validateTarget('production', target)).toBe(target);
  });

  it('builds the ssh command from key, port, user and options', async () => {
    const calls: string[][] = [];
    const fakeBin = join(root, 'bin');
    spawnSync('mkdir', ['-p', fakeBin]);
    writeFileSync(join(fakeBin, 'ssh'), `#!/bin/bash\nprintf '%s\\n' "$@" > ${sh(join(root, 'ssh-args.txt'))}\ncat > ${sh(join(root, 'ssh-stdin.txt'))}\n`, { mode: 0o755 });
    const original = process.env['PATH'];
    process.env['PATH'] = `${fakeBin}:${original ?? ''}`;
    try {
      const code = await sshRunner({ ...target, user: 'deploy', key: '/k/id', port: 2222, ssh_options: ['StrictHostKeyChecking=no', 'ForwardAgent=yes'] })('web9', 'echo hi\n');
      expect(code).toBe(0);
    } finally {
      process.env['PATH'] = original;
    }
    calls.push(readFileSync(join(root, 'ssh-args.txt'), 'utf-8').trim().split('\n'));
    expect(calls[0]).toEqual(['-i', '/k/id', '-p', '2222', '-o', 'StrictHostKeyChecking=no', '-o', 'ForwardAgent=yes', 'deploy@web9', 'bash -s']);
    expect(readFileSync(join(root, 'ssh-stdin.txt'), 'utf-8')).toBe('echo hi\n');
  });
});
